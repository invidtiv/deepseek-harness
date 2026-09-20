/** World routing: a spawned process runs on the connection that owns its cwd. */

import type { Socket } from 'node:net'
import { duplexPair } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SshWorlds, type SshWorldConnection } from '@deepseek-ai/dsh-ssh'
import type { SshStreamEndpoint } from '@deepseek-ai/dsh-ssh/schemas'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshSubprocessRuntime } from '../src/index.ts'

const completion = { outcome: { exitCode: 0, signal: null }, spills: {}, collected: {} }
const spec: SubprocessTerminalSpawnSpec = {
  argv: ['bash'], cwd: '/other/work', terminalType: 'dumb', rows: 24, cols: 80, graceMs: 100,
}
const ordinarySpec: SubprocessSpawnSpec = {
  argv: ['bash'], cwd: '/local/work', stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }, graceMs: 100,
}

/** One connection stub recording the process methods routed to it. */
function wire(id: string) {
  const calls: string[] = []
  const [host, remote] = duplexPair({ allowHalfOpen: true })
  host.on('error', () => {})
  remote.on('error', () => {})
  const finished = Promise.withResolvers<typeof completion>()
  const connection: SshWorldConnection & { calls: string[] } = {
    calls,
    dispose: () => { host.destroy(); remote.destroy(); return Promise.resolve() },
    request: async <T>(method: string, _params: unknown, schema: z.ZodType<T>): Promise<T> => {
      calls.push(method)
      let value: unknown = null
      if (method === 'executable') value = '/remote/bin/node'
      else if (method === 'process.prepare') value = { id, streams: { terminal: { path: '/tmp/terminal', capability: 'a'.repeat(64) } } }
      else if (method === 'process.start') value = { pid: 321 }
      else if (method === 'process.done') value = await finished.promise
      else if (method === 'process.terminate') { finished.resolve(completion) }
      return schema.parse(value)
    },
    connectStream: async (_endpoint: SshStreamEndpoint) => host as unknown as Socket,
    launchBootstrap: '/remote/ptc/process.js',
  }
  return connection
}

/** The local execution world's face, recording what the remote provider delegates. */
function fakeLocal() {
  const handle = { terminate: vi.fn(), waitForExit: vi.fn(async () => true), closeStreams: vi.fn() }
  return {
    handle,
    spawn: vi.fn((_spawn: SubprocessSpawnSpec) => handle),
    spawnTerminal: vi.fn(async (_terminal: SubprocessTerminalSpawnSpec) => handle),
    resolveExecutable: vi.fn(async () => '/usr/bin/local-node'),
    terminalEnvironment: vi.fn(async () => ({ platform: 'posix' as const })),
  }
}

/** Boot the runtime over a pool that routes one workspace to a second connection. */
async function harness(options: { local?: ReturnType<typeof fakeLocal> } = {}) {
  const ctx = new Context()
  const defaultWire = wire('aa910b47-e7d7-467b-8421-3331569dd02b')
  const otherWire = wire('bb910b47-e7d7-467b-8421-3331569dd02b')
  ctx.provide('ssh', defaultWire as never)
  ctx.provide('workspaceRegistry', {
    list: () => [{ transport: 'ssh', environmentId: 'build01', path: '/other/work' }],
  } as never)
  const pool = new SshWorlds(ctx)
  pool.register(undefined, defaultWire)
  pool.register('build01', otherWire)
  if (options.local !== undefined) ctx.provide('localSubprocess', options.local as never)
  const fiber = await ctx.plugin(SshSubprocessRuntime)
  onTestFinished(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  return { runtime: ctx.subprocess, defaultWire, otherWire, local: options.local }
}

describe('SSH subprocess world routing', () => {
  it('runs a spawned terminal on the connection that owns its working directory', async () => {
    const { runtime, defaultWire, otherWire } = await harness()

    const handle = await runtime.spawnTerminal(spec)

    expect(otherWire.calls).toContain('process.prepare')
    expect(defaultWire.calls).toEqual([])
    await handle.terminate()
  })

  it('refuses a targetless lookup while the deployment composes named worlds', async () => {
    const { runtime } = await harness()

    await expect(runtime.resolveExecutable('bash')).rejects.toThrow(/needs one world/)
    expect(() => runtime.terminalEnvironment()).toThrow(/needs one world/)
  })

  it('runs an unclaimed cwd and the targetless lookups on the composed local world', async () => {
    const local = fakeLocal()
    const { runtime, defaultWire, otherWire } = await harness({ local })

    const handle = runtime.spawn(ordinarySpec)
    expect(local.spawn).toHaveBeenCalledWith(ordinarySpec)
    expect(handle).toBe(local.handle)
    expect(await local.spawnTerminal({ ...spec, cwd: '/local/work' })).toBe(local.handle)
    expect(await runtime.resolveExecutable('bash')).toBe('/usr/bin/local-node')
    expect(await runtime.terminalEnvironment()).toEqual({ platform: 'posix' })
    expect(otherWire.calls).toEqual([])
    expect(defaultWire.calls).toEqual([])
  })

  it('reports the installed bootstrap of the world that owns the named cwd', async () => {
    const local = fakeLocal()
    const { runtime } = await harness({ local })

    expect(runtime.launchBootstrap('/other/work')).toBe('/remote/ptc/process.js')
    expect(runtime.launchBootstrap('/local/work')).toBeUndefined()
  })

  it('resolves an executable in the world that owns the named cwd', async () => {
    const local = fakeLocal()
    const { runtime, defaultWire, otherWire } = await harness({ local })

    expect(await runtime.resolveExecutable('node', undefined, undefined, '/other/work')).toBe('/remote/bin/node')
    expect(otherWire.calls).toEqual(['executable'])
    expect(local.resolveExecutable).not.toHaveBeenCalled()
    expect(defaultWire.calls).toEqual([])

    expect(await runtime.resolveExecutable('node', undefined, undefined, '/local/work')).toBe('/usr/bin/local-node')
    expect(local.resolveExecutable).toHaveBeenCalledWith('node', undefined, undefined)
    expect(otherWire.calls).toEqual(['executable'])
  })

  it('resolves a claimed cwd on its connection without a composed local world', async () => {
    const { runtime, defaultWire, otherWire } = await harness()

    expect(await runtime.resolveExecutable('node', undefined, undefined, '/other/work')).toBe('/remote/bin/node')
    expect(otherWire.calls).toEqual(['executable'])
    expect(defaultWire.calls).toEqual([])
  })

  it('keeps a claimed cwd on its SSH world even with a local world composed', async () => {
    const local = fakeLocal()
    const { runtime, otherWire } = await harness({ local })

    const handle = await runtime.spawnTerminal(spec)

    expect(otherWire.calls).toContain('process.prepare')
    expect(local.spawnTerminal).not.toHaveBeenCalled()
    await handle.terminate()
  })
})
