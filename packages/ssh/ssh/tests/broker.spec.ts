/**
 * Lazy broker behavior: one connection per environment on first use, reuse
 * while composed, recomposition after a failed attempt, release with the
 * broker fiber, and remote directory levels for the workspace picker. The real
 * SSH provider cannot run here, so the composition seam is replaced with fakes
 * that register \`ssh\`.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import SshBroker, { internals } from '../src/broker.ts'

/** Connection configs composed by the fake plugin, in composition order. */
const composedConfigs: Array<Record<string, unknown>> = []
/** Environment ids whose fake connection was released. */
const released: string[] = []
/** Answers one helper request; each test installs the methods it exercises. */
let dispatch: (method: string, params: unknown) => unknown = () => { throw new Error('unexpected request') }

/** In-memory named-environment registry: complete entries resolve, others throw. */
class FakeRegistry extends Service {
  constructor(ctx: Context, private readonly complete: Record<string, boolean>) {
    super(ctx, 'sshEnvironments')
  }

  list(): readonly { id: string }[] {
    return Object.keys(this.complete).map(id => ({ id }))
  }

  resolveRuntime(id: string): { node: string; helper: string; helperHash: string; workspace: string } {
    if (this.complete[id] !== true) throw new Error(`incomplete environment ${id}`)
    return { node: '/usr/bin/node', helper: '/opt/dsh-ssh/helper.js', helperHash: 'a'.repeat(64), workspace: '/home/alice' }
  }
}

/** Fake connection: registers \`ssh\` in its realm, answers through \`dispatch\`, and records its release. */
class FakeConnection extends Service {
  readonly environmentId: string
  private isDisposed = false

  constructor(ctx: Context, config: Record<string, unknown>) {
    super(ctx, 'ssh')
    this.environmentId = config.environment as string
    composedConfigs.push(config)
    ctx.effect(() => () => this.dispose())
  }

  get disposed(): boolean { return this.isDisposed }

  async dispose(): Promise<void> {
    this.isDisposed = true
    released.push(this.environmentId)
  }

  request<T>(method: string, params: unknown, result: z.ZodType<T>): Promise<T> {
    return Promise.resolve(result.parse(dispatch(method, params)))
  }
}

/** A plugin whose startup fails, so the composition path rejects. */
class FailingConnection {
  static inject: string[] = []
  constructor() { throw new Error('compose failed') }
}

const contexts: Context[] = []
afterEach(async () => {
  internals.connectionPlugin = FakeConnection
  dispatch = () => { throw new Error('unexpected request') }
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  composedConfigs.length = 0
  released.length = 0
})

/** Boot the broker over a fake registry, with the fake connection plugin installed. */
async function boot(complete: Record<string, boolean>): Promise<{ ctx: Context; broker: SshBroker; fiber: Fiber }> {
  internals.connectionPlugin = FakeConnection
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FakeRegistry, complete)
  const fiber = await ctx.plugin(SshBroker)
  return { ctx, broker: ctx.sshBroker, fiber }
}

/** The helper answers one directory level: a mix of directories and a file. */
function answerDirectory(directory: string, entries: readonly { name: string; type: 'file' | 'directory' }[]): void {
  dispatch = (method) => {
    if (method === 'fs.resolve') return { targetKey: directory, displayPath: directory }
    if (method === 'fs.stat') return { version: 'v1', type: 'directory' }
    if (method === 'fs.list') {
      return entries.map(entry => ({
        name: entry.name,
        type: entry.type,
        target: { targetKey: `${directory}/${entry.name}`, displayPath: `${directory}/${entry.name}` },
      }))
    }
    throw new Error(`unexpected request ${method}`)
  }
}

describe('SshBroker', () => {
  it('offers only environments that can compose a connection', async () => {
    const { broker } = await boot({ build01: true, partial: false })
    expect(broker.list()).toEqual(['build01'])
  })

  it('composes one connection per environment and reuses it', async () => {
    const { broker } = await boot({ build01: true })
    const first = await broker.connect('build01')
    const second = await broker.connect('build01')

    expect(second).toBe(first)
    expect(composedConfigs).toEqual([{
      environment: 'build01',
      node: '/usr/bin/node',
      helper: '/opt/dsh-ssh/helper.js',
      helperHash: 'a'.repeat(64),
      workspace: '/home/alice',
    }])
  })

  it('forgets a failed composition so a later attempt recomposes', async () => {
    const { broker } = await boot({ build01: true })
    internals.connectionPlugin = FailingConnection

    await expect(broker.connect('build01')).rejects.toThrow('compose failed')

    internals.connectionPlugin = FakeConnection
    await expect(broker.connect('build01')).resolves.toBeInstanceOf(FakeConnection)
    expect(composedConfigs).toHaveLength(1)
  })

  it('reports an environment the registry cannot resolve', async () => {
    const { broker } = await boot({ complete: true })
    await expect(broker.connect('missing')).rejects.toThrow(/incomplete environment missing/)
  })

  it('releases every composed connection with the broker fiber', async () => {
    const { broker, fiber } = await boot({ build01: true })
    const connection = await broker.connect('build01') as unknown as FakeConnection

    await fiber.dispose()
    expect(connection.disposed).toBe(true)
    expect(released).toEqual(['build01'])
  })

  it('refuses to connect once the broker is disposed', async () => {
    const { broker, fiber } = await boot({ build01: true })
    await fiber.dispose()
    await expect(broker.connect('build01')).rejects.toThrow('the broker is disposed')
  })

  it('lists a remote level with its ancestry and the environment workspace', async () => {
    const { broker } = await boot({ build01: true })
    answerDirectory('/srv/app', [
      { name: 'src', type: 'directory' },
      { name: 'readme.md', type: 'file' },
      { name: 'zeta', type: 'directory' },
      { name: 'alpha', type: 'directory' },
    ])

    const listing = await broker.listDirectory('build01', '/srv/app')
    expect(listing.path).toBe('/srv/app')
    expect(listing.home).toBe('/home/alice')
    expect(listing.entries).toEqual([
      { name: 'alpha', path: '/srv/app/alpha' },
      { name: 'src', path: '/srv/app/src' },
      { name: 'zeta', path: '/srv/app/zeta' },
    ])
    expect(listing.crumbs).toEqual([
      { name: '/', path: '/' },
      { name: 'srv', path: '/srv' },
      { name: 'app', path: '/srv/app' },
    ])
  })

  it('lists the environment workspace when no path is given', async () => {
    const { broker } = await boot({ build01: true })
    answerDirectory('/home/alice', [{ name: 'project', type: 'directory' }])

    await expect(broker.listDirectory('build01')).resolves.toMatchObject({
      path: '/home/alice',
      entries: [{ name: 'project', path: '/home/alice/project' }],
    })
  })

  it('refuses a remote target that is absent or not a directory', async () => {
    const { broker } = await boot({ build01: true })
    dispatch = method => method === 'fs.resolve'
      ? { targetKey: '/srv/file', displayPath: '/srv/file' }
      : null
    await expect(broker.listDirectory('build01', '/srv/file')).rejects.toThrow('is not a remote directory')

    dispatch = method => method === 'fs.resolve'
      ? { targetKey: '/srv/file', displayPath: '/srv/file' }
      : { version: 'v1', type: 'file' }
    await expect(broker.listDirectory('build01', '/srv/file')).rejects.toThrow('is not a remote directory')
  })

  it('creates one remote child directory under the given policy', async () => {
    const { broker } = await boot({ build01: true })
    const calls: Array<{ method: string; params: unknown }> = []
    dispatch = (method, params) => {
      calls.push({ method, params })
      if (method === 'fs.resolve') {
        const request = params as { path: string; cwd?: string }
        const resolved = request.cwd === undefined ? request.path : `${request.cwd}/${request.path}`
        return { targetKey: resolved, displayPath: resolved }
      }
      return null
    }

    const created = await broker.createDirectory('build01', '/home/alice', 'project', {
      mode: 'danger-full-access', workspaceRoot: '/home/alice',
    })
    expect(created).toBe('/home/alice/project')
    expect(calls.at(-1)).toEqual({
      method: 'fs.mkdir',
      params: {
        target: { targetKey: '/home/alice/project', displayPath: '/home/alice/project' },
        policy: { mode: 'danger-full-access', workspaceRoot: '/home/alice' },
      },
    })
  })
})
