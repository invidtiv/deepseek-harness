/**
 * Target routing: every operation goes to the connection that owns its world,
 * an opened text stream stays on the connection that opened it, an explicitly
 * chosen environment resolves through the pool, and a path no SSH world claims
 * is served by the composed local execution world.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { FsTargetKey, type FsTarget } from '@deepseek-ai/dsh-fs'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshWorldUnavailableError } from '../../ssh/src/worlds.ts'
import { SshFileSystem } from '../src/index.ts'

type Dispatch = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>

const REMOTE = '/remote/work'
const OTHER = '/other/work'
const LOCAL_PATH = '/tmp/local.txt'

const target = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })

/** The controller policy service the filesystem provider reads writable modes from. */
class Policy extends Service {
  readonly defaultMode = 'workspace-write'
  constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
  resolve(): { mode: 'workspace-write'; workspaceRoot: string } { return { mode: 'workspace-write', workspaceRoot: REMOTE } }
}

/** A connection face whose requests are recorded and answered by one dispatch. */
function connection(dispatch: Dispatch) {
  return {
    request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return Promise.resolve(dispatch(method, params, signal)).then(value => result.parse(value))
    },
  }
}

/** The local execution world's face, recording what the remote provider delegates. */
function fakeLocal() {
  return {
    resolve: vi.fn(async (path: string) => ({ targetKey: FsTargetKey(`host:${path}`), displayPath: path })),
    stat: vi.fn(async () => ({ version: 'l1', type: 'file' as const, size: 2 })),
    lstat: vi.fn(async () => ({ version: 'l1', type: 'file' as const, size: 2 })),
    listDir: vi.fn(async () => []),
    readText: vi.fn(async () => 'local'),
    streamText: vi.fn(async () => (async function* () { yield 'local' })()),
    readBytes: vi.fn(async () => new Uint8Array([1])),
    readByteRange: vi.fn(async () => new Uint8Array([1])),
    mkdir: vi.fn(async () => {}),
    writeText: vi.fn(async () => ({ operation: 'create' as const, version: 'l2', before: null, after: 'x' })),
    editText: vi.fn(async () => ({ version: 'l3', before: 'a', after: 'b' })),
    fileUrl: vi.fn(() => 'file:///host'),
    contains: vi.fn(() => true),
    processPathFromHostPath: vi.fn(() => '/host'),
  }
}

/**
 * Boot the provider over a default wire plus an optional pool that routes some
 * paths elsewhere, an optional local execution world, or a single connection.
 */
async function harness(options: {
  pool?: (path: string) => boolean
  environment?: string
  ownEnvironmentId?: string
  local?: ReturnType<typeof fakeLocal>
  noOwn?: boolean
} = {}) {
  const defaultDispatch = vi.fn<Dispatch>()
  const poolDispatch = vi.fn<Dispatch>()
  class DefaultConnection extends Service {
    readonly environmentId: string | undefined
    constructor(ctx: Context, config?: { environmentId?: string }) {
      super(ctx, 'ssh')
      this.environmentId = config?.environmentId
    }
    async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return result.parse(await defaultDispatch(method, params, signal))
    }
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  if (options.noOwn !== true) {
    await ctx.plugin(DefaultConnection, options.ownEnvironmentId === undefined ? {} : { environmentId: options.ownEnvironmentId })
  }
  await ctx.plugin(Policy)
  const pool = connection(poolDispatch)
  if (options.pool !== undefined || options.environment !== undefined) {
    ctx.provide('sshWorlds', {
      connectionFor: (path: string) => options.pool?.(path) === true ? pool : ctx.ssh,
      connectionForEnvironment: (id: string) => {
        // A path the pool routes by locator records that pool world on its
        // target; an explicit request names the environment itself.
        const expected = options.environment ?? 'world-b'
        if (id !== expected) throw new SshWorldUnavailableError(id)
        return pool
      },
      worldFor: (path: string) => options.pool?.(path) === true ? 'world-b' : undefined,
    } as never)
  }
  if (options.local !== undefined) ctx.provide('localFs', options.local as never)
  await ctx.plugin(SshFileSystem)
  return { fs: ctx.fs, defaultDispatch, poolDispatch, local: options.local }
}

describe('SSH filesystem target routing', () => {
  it('sends an unclaimed path to the deployment connection', async () => {
    const { fs, defaultDispatch, poolDispatch } = await harness({ pool: path => path.startsWith(OTHER) })
    defaultDispatch.mockResolvedValue({ version: 'v1', type: 'file', size: 1 })

    await fs.stat(target(`${REMOTE}/file.txt`))

    expect(defaultDispatch).toHaveBeenCalledWith('fs.stat', { target: target(`${REMOTE}/file.txt`) }, undefined)
    expect(poolDispatch).not.toHaveBeenCalled()
  })

  it('sends a pooled path, including its resolution, to that world', async () => {
    const { fs, defaultDispatch, poolDispatch } = await harness({ pool: path => path.startsWith(OTHER) })
    poolDispatch.mockImplementation(async method => method === 'fs.resolve'
      ? { targetKey: `${OTHER}/file.txt`, displayPath: `${OTHER}/file.txt` }
      : { version: 'v1', type: 'file', size: 1 })

    const resolved = await fs.resolve(`${OTHER}/file.txt`)
    await fs.stat(resolved)

    expect(poolDispatch).toHaveBeenNthCalledWith(1, 'fs.resolve', { path: `${OTHER}/file.txt`, cwd: undefined }, undefined)
    // The world identity stays host-side: the wire carries the remote path alone.
    expect(poolDispatch).toHaveBeenNthCalledWith(2, 'fs.stat', {
      target: { targetKey: `${OTHER}/file.txt`, displayPath: `${OTHER}/file.txt` },
    }, undefined)
    expect(defaultDispatch).not.toHaveBeenCalled()
  })

  it('keeps an opened text stream on the connection that opened it', async () => {
    const { fs, defaultDispatch, poolDispatch } = await harness({ pool: path => path.startsWith(OTHER) })
    const id = '00000000-0000-4000-8000-000000000001'
    poolDispatch.mockImplementation(async (method) => {
      if (method === 'fs.stream') return id
      if (method === 'fs.next') return { done: true, value: 'tail' }
      return null
    })

    const chunks: string[] = []
    for await (const chunk of await fs.streamText(target(`${OTHER}/file.txt`))) chunks.push(chunk)

    expect(chunks).toEqual(['tail'])
    expect(poolDispatch.mock.calls.map(call => call[0])).toEqual(['fs.stream', 'fs.next'])
    expect(defaultDispatch).not.toHaveBeenCalled()
  })

  it('falls back to the deployment connection when no pool is composed', async () => {
    const { fs, defaultDispatch, poolDispatch } = await harness()
    defaultDispatch.mockResolvedValue({ version: 'v1', type: 'file', size: 1 })

    await fs.stat(target(`${OTHER}/file.txt`))

    expect(defaultDispatch).toHaveBeenCalledTimes(1)
    expect(poolDispatch).not.toHaveBeenCalled()
  })

  it('resolves an explicitly chosen environment through the pool and records its world', async () => {
    const { fs, defaultDispatch, poolDispatch } = await harness({ environment: 'world-b' })
    poolDispatch.mockImplementation(async method => method === 'fs.resolve'
      ? { targetKey: `${OTHER}/file.txt`, displayPath: `${OTHER}/file.txt` }
      : { version: 'v1', type: 'file', size: 1 })

    const resolved = await fs.resolve(`${OTHER}/file.txt`, { environmentId: 'world-b' })
    // The host-side target keeps the world; the wire sees only the remote path.
    expect(fs.processPath(resolved)).toBe(`${OTHER}/file.txt`)
    expect(String(resolved.targetKey)).not.toBe(`${OTHER}/file.txt`)

    await fs.stat(resolved)
    expect(poolDispatch).toHaveBeenNthCalledWith(2, 'fs.stat', {
      target: { targetKey: `${OTHER}/file.txt`, displayPath: `${OTHER}/file.txt` },
    }, undefined)
    expect(defaultDispatch).not.toHaveBeenCalled()
  })

  it('serves a path no SSH world claims from the composed local execution world', async () => {
    const local = fakeLocal()
    const { fs, defaultDispatch, poolDispatch } = await harness({ pool: path => path.startsWith(OTHER), local })
    poolDispatch.mockResolvedValue(null)

    const resolved = await fs.resolve(LOCAL_PATH)
    expect(local.resolve).toHaveBeenCalledWith(LOCAL_PATH, undefined)
    expect(fs.processPath(resolved)).toBe(`host:${LOCAL_PATH}`)
    expect(await fs.stat(resolved)).toMatchObject({ type: 'file' })
    expect(fs.fileUrl(resolved)).toBe('file:///host')
    expect(fs.contains(resolved, resolved)).toBe(true)
    expect(fs.processPathFromHostPath('/host')).toBe('/host')
    expect(defaultDispatch).not.toHaveBeenCalled()
    expect(poolDispatch).not.toHaveBeenCalled()
  })

  it('delegates every unclaimed-path operation to the local world', async () => {
    const local = fakeLocal()
    const { fs } = await harness({ pool: path => path.startsWith(OTHER), local })
    const resolved = await fs.resolve(LOCAL_PATH)

    await fs.lstat(LOCAL_PATH)
    await fs.readText(resolved)
    await fs.readBytes(resolved, undefined, 4)
    await fs.readByteRange(resolved, { offset: 0, length: 2 })
    await fs.listDir(resolved)
    await fs.mkdir(resolved)
    await fs.writeText(resolved, 'x')
    await fs.editText(resolved, { oldString: 'a', newString: 'b', replaceAll: false })
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(resolved)) chunks.push(chunk)

    expect(chunks).toEqual(['local'])
    for (const method of ['lstat', 'readText', 'readBytes', 'readByteRange', 'listDir', 'mkdir', 'writeText', 'editText', 'streamText'] as const) {
      expect(local[method]).toHaveBeenCalled()
    }
  })

  it('serves its own environment from a single-connection deployment', async () => {
    const { fs, defaultDispatch } = await harness({ ownEnvironmentId: 'build01' })
    defaultDispatch.mockImplementation(async method => method === 'fs.resolve'
      ? { targetKey: `${REMOTE}/file.txt`, displayPath: `${REMOTE}/file.txt` }
      : { version: 'v1', type: 'file', size: 1 })

    const resolved = await fs.resolve(`${REMOTE}/file.txt`, { environmentId: 'build01' })
    await fs.stat(resolved)

    expect(defaultDispatch).toHaveBeenNthCalledWith(2, 'fs.stat', {
      target: { targetKey: `${REMOTE}/file.txt`, displayPath: `${REMOTE}/file.txt` },
    }, undefined)
  })

  it('refuses an environment a single-connection deployment did not resolve', async () => {
    const { fs } = await harness({ ownEnvironmentId: 'build01' })
    await expect(fs.resolve(`${REMOTE}/file.txt`, { environmentId: 'other' }))
      .rejects.toThrow(SshWorldUnavailableError)
  })

  it('refuses an explicitly chosen environment when no connection is composed', async () => {
    const { fs } = await harness({ noOwn: true })
    await expect(fs.resolve(`${REMOTE}/file.txt`, { environmentId: 'build01' }))
      .rejects.toThrow(SshWorldUnavailableError)
  })

  it('refuses a remote path when no connection and no local world are composed', async () => {
    const { fs } = await harness({ noOwn: true })
    await expect(fs.resolve(`${REMOTE}/file.txt`)).rejects.toThrow(SshWorldUnavailableError)
  })
})
