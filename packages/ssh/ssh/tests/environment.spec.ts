import { describe, expect, it } from 'vitest'
import { buildDirectArgv, buildForwardArgv, buildMasterArgv, resolveConnectionEnvironment, resolveSshEnvironment } from '../src/environment.ts'

describe('resolveSshEnvironment', () => {
  it('applies the owned host-key and keepalive defaults', () => {
    expect(resolveSshEnvironment({ host: 'build01' })).toEqual({
      host: 'build01',
      hostKeyChecking: 'yes',
      serverAliveIntervalMs: 10_000,
      serverAliveCountMax: 3,
    })
  })

  it('preserves explicit connection options', () => {
    const environment = resolveSshEnvironment({
      host: 'build01.example',
      port: 2222,
      user: 'alice',
      identityFile: '~/.ssh/id_ed25519',
      identityAgent: '/run/agent.sock',
      proxyJump: 'bastion',
      configFile: '/etc/ssh/ssh_config',
      hostKeyChecking: 'accept-new',
      connectTimeoutMs: 15_000,
      serverAliveIntervalMs: 5_000,
      serverAliveCountMax: 1,
    })
    expect(environment).toMatchObject({ port: 2222, user: 'alice', hostKeyChecking: 'accept-new' })
  })

  it('rejects a port outside the TCP range', () => {
    expect(() => resolveSshEnvironment({ host: 'build01', port: 0 })).toThrow()
    expect(() => resolveSshEnvironment({ host: 'build01', port: 65_536 })).toThrow()
  })

  it('rejects a host or user that cannot be one argv token', () => {
    expect(() => resolveSshEnvironment({ host: 'build01; rm -rf /' })).toThrow()
    expect(() => resolveSshEnvironment({ host: 'build01', user: 'a b' })).toThrow()
  })

  it('rejects a line break in any value that becomes one -o argument', () => {
    expect(() => resolveSshEnvironment({ host: 'build01', proxyJump: 'bastion\n-o ForwardAgent=yes' })).toThrow()
    expect(() => resolveSshEnvironment({ host: 'build01', identityAgent: 'a\r\nb' })).toThrow()
  })

  it('requires a key or config file path to be absolute or home-relative', () => {
    expect(() => resolveSshEnvironment({ host: 'build01', identityFile: 'keys/id' })).toThrow()
    expect(() => resolveSshEnvironment({ host: 'build01', configFile: 'ssh_config' })).toThrow()
  })
})

describe('buildMasterArgv', () => {
  it('keeps the helper transport flags and security posture', () => {
    const argv = buildMasterArgv(resolveSshEnvironment({ host: 'build01' }), '/tmp/master', "'node' 'helper'")
    expect(argv).toContain('ControlPersist=no')
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('ForwardAgent=no')
    expect(argv).toContain('ClearAllForwardings=yes')
    expect(argv).toContain('ServerAliveInterval=10')
    expect(argv).toContain('ServerAliveCountMax=3')
    expect(argv.at(-1)).toBe("'node' 'helper'")
  })

  it('renders every explicit OpenSSH option in the documented position', () => {
    const argv = buildMasterArgv(resolveSshEnvironment({
      host: 'build01',
      port: 2222,
      user: 'alice',
      identityFile: '/home/alice/.ssh/id_ed25519',
      identityAgent: '/run/agent.sock',
      proxyJump: 'bastion',
      configFile: '/etc/ssh/ssh_config',
      connectTimeoutMs: 15_000,
    }), '/tmp/master')
    expect(argv.slice(0, 4)).toEqual(['-T', '-M', '-S', '/tmp/master'])
    expect(argv[4]).toBe('-F')
    expect(argv[5]).toBe('/etc/ssh/ssh_config')
    expect(argv).toContain('ConnectTimeout=15')
    expect(argv).toContain('ProxyJump=bastion')
    expect(argv).toContain('IdentityAgent=/run/agent.sock')
    expect(argv.slice(-5)).toEqual(['-p', '2222', '-l', 'alice', 'build01'])
    expect(argv.indexOf('-i')).toBeLessThan(argv.indexOf('-p'))
    expect(argv[argv.indexOf('-i') + 1]).toBe('/home/alice/.ssh/id_ed25519')
  })

  it('omits an absent optional option instead of emitting a default', () => {
    const argv = buildMasterArgv(resolveSshEnvironment({ host: 'build01' }), '/tmp/master')
    expect(argv.some(argument => argument.startsWith('ConnectTimeout='))).toBe(false)
    expect(argv.some(argument => argument.startsWith('ProxyJump='))).toBe(false)
    expect(argv).not.toContain('-p')
    expect(argv).not.toContain('-l')
    expect(argv.at(-1)).toBe('build01')
  })

  it('treats a missing host-key policy as strict', () => {
    expect(buildMasterArgv({ host: 'build01' }, '/tmp/master')).toContain('StrictHostKeyChecking=yes')
  })
})

describe('buildDirectArgv', () => {
  it('omits control-master multiplexing and keeps the shared security posture', () => {
    const argv = buildDirectArgv(resolveSshEnvironment({ host: 'build01', configFile: '/etc/ssh/ssh_config' }), "'node' 'helper'")
    expect(argv[0]).toBe('-T')
    expect(argv).not.toContain('-M')
    expect(argv).not.toContain('-S')
    expect(argv).not.toContain('ControlPersist=no')
    expect(argv.slice(1, 3)).toEqual(['-F', '/etc/ssh/ssh_config'])
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv.at(-1)).toBe("'node' 'helper'")
  })

  it('carries no config file and ends at the destination without a remote command', () => {
    const argv = buildDirectArgv(resolveSshEnvironment({ host: 'build01' }))
    expect(argv).not.toContain('-F')
    expect(argv.at(-1)).toBe('build01')
  })
})

describe('buildForwardArgv', () => {
  it('forwards one loopback port to one remote socket', () => {
    const argv = buildForwardArgv(resolveSshEnvironment({ host: 'build01', configFile: '/etc/ssh/ssh_config' }), 43_210, '/tmp/root/stream')
    expect(argv.slice(0, 4)).toEqual(['-N', '-o', 'ExitOnForwardFailure=yes', '-L'])
    expect(argv[4]).toBe('127.0.0.1:43210:/tmp/root/stream')
    expect(argv).not.toContain('-T')
    expect(argv).not.toContain('ClearAllForwardings=yes')
    expect(argv.at(-1)).toBe('build01')
  })
})

describe('resolveConnectionEnvironment', () => {
  it('resolves an inline destination with the owned defaults', () => {
    expect(resolveConnectionEnvironment({ host: 'build01', port: 2222 }, undefined)).toEqual({
      host: 'build01',
      port: 2222,
      hostKeyChecking: 'yes',
      serverAliveIntervalMs: 10_000,
      serverAliveCountMax: 3,
    })
  })

  it('leaves an absent override to OpenSSH', () => {
    const resolved = resolveConnectionEnvironment({ host: 'build01' }, undefined)
    expect(resolved.port).toBeUndefined()
    expect(resolved.user).toBeUndefined()
  })

  it('carries every inline override into the resolved environment', () => {
    expect(resolveConnectionEnvironment({
      host: 'build01',
      port: 2222,
      user: 'alice',
      identityFile: '~/.ssh/id_ed25519',
      identityAgent: '/run/agent.sock',
      proxyJump: 'bastion',
      configFile: '/etc/ssh/ssh_config',
      hostKeyChecking: 'accept-new',
      connectTimeoutMs: 15_000,
      serverAliveIntervalMs: 5_000,
      serverAliveCountMax: 1,
    }, undefined)).toMatchObject({
      user: 'alice', identityFile: '~/.ssh/id_ed25519', proxyJump: 'bastion', hostKeyChecking: 'accept-new',
    })
  })

  it('resolves a named environment through the registry', () => {
    const registry = { resolve: (id: string) => ({ host: `resolved-${id}`, hostKeyChecking: 'yes' as const }) }
    expect(resolveConnectionEnvironment({ environment: 'build01' }, registry))
      .toEqual({ host: 'resolved-build01', hostKeyChecking: 'yes' })
  })

  it('fails loud when a named environment has no composed registry', () => {
    expect(() => resolveConnectionEnvironment({ environment: 'build01' }, undefined))
      .toThrow('requires the ssh-environments registry')
  })

  it('requires one of host or environment', () => {
    expect(() => resolveConnectionEnvironment({}, undefined)).toThrow('one of host or environment')
  })
})
