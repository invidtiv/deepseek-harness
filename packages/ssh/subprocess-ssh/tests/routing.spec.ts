/** World routing: a spawned process runs on the connection that owns its cwd. */

import type { Socket } from 'node:net'
import { duplexPair } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SshWorlds, type SshWorldConnection } from '@deepseek-ai/dsh-ssh'
import type { SshStreamEndpoint } from '@deepseek-ai/dsh-ssh/schemas'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { SshSubprocessRuntime } from '../src/index.ts'

const completion = { outcome: { exitCode: 0, signal: null }, spills: {}, collected: {} }
const spec: SubprocessTerminalSpawnSpec = {
  argv: ['bash'], cwd: '/other/work', terminalType: 'dumb', rows: 24, cols: 80, graceMs: 100,
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
      if (method === 'process.prepare') value = { id, streams: { terminal: { path: '/tmp/terminal', capability: 'a'.repeat(64) } } }
      else if (method === 'process.start') value = { pid: 321 }
      else if (method === 'process.done') value = await finished.promise
      else if (method === 'process.terminate') { finished.resolve(completion) }
      return schema.parse(value)
    },
    connectStream: async (_endpoint: SshStreamEndpoint) => host as unknown as Socket,
  }
  return connection
}

/** Boot the runtime over a pool that routes one workspace to a second connection. */
async function harness() {
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
  const fiber = await ctx.plugin(SshSubprocessRuntime)
  onTestFinished(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  return { runtime: ctx.subprocess, defaultWire, otherWire }
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
})
