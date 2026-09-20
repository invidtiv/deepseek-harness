/** The Windows client transport forwards each stream through a dedicated loopback OpenSSH session. */
import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SshRpcPeer } from '../src/protocol.ts'
import { internals, SshConnection } from '../src/index.ts'

const transport = vi.hoisted(() => ({
  spawn: vi.fn(), tls: vi.fn(), createServer: vi.fn(), createConnection: vi.fn(),
  actual: undefined as unknown,
}))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: transport.spawn,
  execFile: vi.fn(),
}))
vi.mock('node:tls', async original => ({
  ...await original<typeof import('node:tls')>(),
  connect: transport.tls,
}))
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>()
  transport.actual = actual
  return { ...actual, createServer: transport.createServer, createConnection: transport.createConnection }
})

class Stream extends Duplex {
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback() }
  disableRenegotiation(): void {}
}

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    queueMicrotask(() => { this.emit('close', 0, null) })
    return true
  }
}

/** A server whose bound address cannot be read, as the transport must refuse to forward. */
class AddresslessServer extends EventEmitter {
  listen(_port: number, _host: string, callback: () => void): this {
    queueMicrotask(() => { callback() })
    return this
  }
  address(): null { return null }
  close(callback?: () => void): this {
    queueMicrotask(() => { callback?.() })
    return this
  }
}

const helperHello = {
  protocol: 1, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0',
  node: '/usr/bin/node', root: '/tmp/remote-helper', workspace: '/workspace',
}

interface Behavior {
  forwarderExits?: boolean
  forwarderErrors?: boolean
  forwarderBinds?: boolean
  requestTimeoutMs?: number
}

const hostPlatform = internals.platform

/** Restore the loopback implementations the transport calls through. */
function resetNet(): void {
  const actual = transport.actual as typeof import('node:net') | undefined
  if (actual === undefined) throw new Error('node:net mock is not initialized')
  transport.createServer.mockImplementation((...args: unknown[]) =>
    (actual.createServer as unknown as (...args: unknown[]) => unknown)(...args))
  transport.createConnection.mockImplementation((...args: unknown[]) =>
    (actual.createConnection as unknown as (...args: unknown[]) => unknown)(...args))
}

afterEach(() => {
  internals.platform = hostPlatform
  vi.restoreAllMocks()
  transport.spawn.mockReset()
  transport.tls.mockReset()
  resetNet()
})

/** Boot the connection with a fake helper child and a fake forwarder standing in for OpenSSH. */
function boot(behavior: Behavior = {}) {
  resetNet()
  const forwarders: Child[] = []
  const servers: Server[] = []
  const helperChild = new Child()
  const helper = new SshRpcPeer(helperChild.stdin, helperChild.stdout, 4096, 8, async (method) => {
    if (method === 'hello') return helperHello
    if (method === 'close' || method === 'heartbeat') return null
    throw new Error(`unexpected helper request ${method}`)
  })
  transport.spawn.mockImplementation((_file: string, args: string[]) => {
    if (!args.includes('-N')) return helperChild
    const forwarder = new Child()
    forwarders.push(forwarder)
    if (behavior.forwarderExits === true) queueMicrotask(() => { forwarder.emit('close', 1, null) })
    if (behavior.forwarderErrors === true) queueMicrotask(() => { forwarder.emit('error', new Error('forwarder failed')) })
    if (behavior.forwarderExits !== true && behavior.forwarderBinds !== false) {
      const spec = args[args.indexOf('-L') + 1] ?? ''
      const server = createServer((socket) => { socket.on('error', () => {}); socket.resume() })
      server.on('error', () => {})
      servers.push(server)
      server.listen(Number(spec.split(':')[1]), '127.0.0.1')
    }
    return forwarder
  })
  transport.tls.mockImplementation((options: { socket: Socket }) => {
    const raw = options.socket
    const secure = new Stream()
    raw.once('close', () => { secure.destroy() })
    secure.once('close', () => { raw.destroy() })
    queueMicrotask(() => { secure.emit('secureConnect') })
    return secure
  })
  internals.platform = 'win32'
  const ctx = new Context()
  const service = new SshConnection(ctx, {
    host: 'win-test', node: '/usr/bin/node', helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64),
    workspace: '/workspace', requestTimeoutMs: behavior.requestTimeoutMs ?? 5000,
    maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
  })
  onTestFinished(async () => {
    await service.dispose().catch(() => {})
    helper.close()
    for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await ctx.fiber.dispose()
  })
  return { service, forwarders }
}

describe('SSH direct transport', () => {
  it('launches the helper without control-master multiplexing', async () => {
    const { service } = boot()
    await service.ready
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv[0]).toBe('-T')
    expect(argv).not.toContain('-M')
    expect(argv).not.toContain('-S')
    expect(argv).not.toContain('ControlPersist=no')
    expect(argv.at(-1)).toBe("'/usr/bin/node' '--disable-sigusr1' '/opt/dsh/helper.js'")
  })

  it('forwards a stream through a loopback session and releases it with the socket', async () => {
    const { service, forwarders } = boot({ forwarderErrors: true })
    await service.ready
    const socket = await service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    const argv = transport.spawn.mock.calls.find(call => (call[1] as string[]).includes('-N'))?.[1] as string[]
    const port = (argv[argv.indexOf('-L') + 1] as string).split(':')[1]
    expect(argv.slice(0, 4)).toEqual(['-N', '-o', 'ExitOnForwardFailure=yes', '-L'])
    expect(argv).toContain(`127.0.0.1:${port}:/tmp/remote-helper/control`)
    expect(argv).not.toContain('ControlPersist=no')
    expect(argv.at(-1)).toBe('win-test')
    socket.destroy()
    await vi.waitFor(() => { expect(forwarders[0]?.signals).toContain('SIGTERM') })
  })

  it('fails loud when the forwarder exits before it accepts the stream', async () => {
    const { service } = boot({ forwarderExits: true })
    await service.ready
    await expect(service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }))
      .rejects.toThrow('loopback forwarder exited')
  })

  it('fails loud when the forwarder never accepts a connection', async () => {
    const { service } = boot({ forwarderBinds: false, requestTimeoutMs: 40 })
    await service.ready
    await expect(service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }))
      .rejects.toThrow('did not accept the stream in time')
  })

  it('fails loud when no loopback port can be reserved', async () => {
    transport.createServer.mockReturnValueOnce(new AddresslessServer())
    const { service } = boot()
    await service.ready
    await expect(service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }))
      .rejects.toThrow('could not reserve a port')
  })

  it('stops a pending loopback connect when the caller aborts', async () => {
    const pending = new Stream()
    transport.createConnection.mockReturnValueOnce(pending)
    const { service } = boot({ forwarderBinds: false })
    await service.ready
    const controller = new AbortController()
    const call = service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }, controller.signal)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    controller.abort(new Error('caller stopped'))
    await expect(call).rejects.toThrow('caller stopped')
    expect(pending.destroyed).toBe(true)
  })

  it('terminates every live forwarder on disposal', async () => {
    const { service, forwarders } = boot()
    await service.ready
    await service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    await service.dispose()
    expect(forwarders[0]?.signals).toContain('SIGTERM')
  })
})
