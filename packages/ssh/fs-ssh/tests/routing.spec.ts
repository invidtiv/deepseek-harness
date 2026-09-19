/**
 * Target routing: every operation goes to the pool connection that owns its
 * world, and an opened text stream stays on the connection that opened it.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { FsTargetKey, type FsTarget } from '@deepseek-ai/dsh-fs'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshFileSystem } from '../src/index.ts'

type Dispatch = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>

const REMOTE = '/remote/work'
const OTHER = '/other/work'

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

/** Boot the provider over a default wire plus an optional pool routing some paths elsewhere. */
async function harness(options: { pool?: (path: string) => boolean } = {}) {
  const defaultDispatch = vi.fn<Dispatch>()
  const poolDispatch = vi.fn<Dispatch>()
  class DefaultConnection extends Service {
    constructor(ctx: Context) { super(ctx, 'ssh') }
    async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return result.parse(await defaultDispatch(method, params, signal))
    }
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(DefaultConnection)
  await ctx.plugin(Policy)
  const pool = connection(poolDispatch)
  if (options.pool !== undefined) {
    ctx.provide('sshWorlds', { connectionFor: (path: string) => options.pool!(path) ? pool : ctx.ssh } as never)
  }
  await ctx.plugin(SshFileSystem)
  return { fs: ctx.fs, defaultDispatch, poolDispatch }
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
    expect(poolDispatch).toHaveBeenNthCalledWith(2, 'fs.stat', { target: resolved }, undefined)
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
})
