/**
 * The Web file explorer reads its configured execution world, not the Harness
 * host: a remote filesystem provider serves every listing and read, and an
 * absent listing path resolves inside that world instead of naming the host
 * process cwd. Driven through the real SSH provider over a stub wire, so no
 * host path can satisfy the assertions by accident.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { WorkspaceFileBrowse } from '../src/file-browse.ts'

type Dispatch = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>

/** One byte past the viewer's read cap, which proves truncation without the whole file. */
const READ_CAP = 2 * 1024 * 1024

/** The remote provider over a stub wire: no SSH connection and no host filesystem exist. */
async function setup() {
  const dispatch = vi.fn<Dispatch>()
  class WireConnection extends Service {
    constructor(ctx: Context) { super(ctx, 'ssh') }
    async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return result.parse(await dispatch(method, params, signal))
    }
  }
  class Policy extends Service {
    readonly defaultMode = 'read-only'
    constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
    resolve(): SandboxExecutionPolicy { return { mode: 'read-only', workspaceRoot: '/srv/project' } }
  }
  const ctx = new Context()
  const fibers = [await ctx.plugin(WireConnection), await ctx.plugin(Policy), await ctx.plugin(SshFileSystem)]
  onTestFinished(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  return { browse: new WorkspaceFileBrowse(ctx.fs), dispatch }
}

/** Every path the provider put on the wire, which must stay inside the remote world. */
function wirePaths(dispatch: ReturnType<typeof vi.fn<Dispatch>>): string[] {
  return dispatch.mock.calls
    .map(([, params]) => (params as { path?: string }).path)
    .filter((path): path is string => path !== undefined)
}

describe('WorkspaceFileBrowse over a remote execution world', () => {
  it('lists the world root for an absent path instead of the host cwd', async () => {
    const { browse, dispatch } = await setup()
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.resolve') return { targetKey: '/srv', displayPath: '/srv' }
      if (method === 'fs.stat') return { version: 'v1', type: 'directory' }
      if (method === 'fs.list') {
        return [
          { name: 'app', type: 'directory', target: { targetKey: '/srv/app', displayPath: '/srv/app' } },
          { name: 'readme.md', type: 'file', target: { targetKey: '/srv/readme.md', displayPath: '/srv/readme.md' }, size: 12 },
        ]
      }
      throw new Error(`unexpected method ${method}`)
    })

    const listing = await browse.listFiles({}, new AbortController().signal)

    expect(listing.path).toBe('/srv')
    expect(listing.entries).toEqual([
      { name: 'app', path: '/srv/app', kind: 'directory', hidden: false },
      { name: 'readme.md', path: '/srv/readme.md', kind: 'file', hidden: false },
    ])
    expect(dispatch).toHaveBeenCalledWith('fs.resolve', { path: '/', cwd: undefined }, expect.anything())
    // The host process cwd is a Windows drive path or a POSIX absolute path; no
    // wire path may name it, and every one stays absolute in the remote world.
    expect(wirePaths(dispatch)).not.toContain(process.cwd())
  })

  it('reads file contents and the truncation window through the remote world', async () => {
    const { browse, dispatch } = await setup()
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.resolve') return { targetKey: '/srv/notes.md', displayPath: '/srv/notes.md' }
      if (method === 'fs.stat') return { version: 'v1', type: 'file', size: 6 }
      if (method === 'fs.readRange') return Buffer.from('hello\n').toString('base64')
      throw new Error(`unexpected method ${method}`)
    })

    const contents = await browse.readFile({ path: '/srv/notes.md' }, new AbortController().signal)

    expect(contents).toMatchObject({ path: '/srv/notes.md', content: 'hello\n', size: 6, truncated: false, binary: false })
    expect(dispatch).toHaveBeenCalledWith(
      'fs.readRange',
      { target: { targetKey: '/srv/notes.md', displayPath: '/srv/notes.md' }, offset: 0, length: READ_CAP + 1 },
      expect.anything(),
    )
    expect(wirePaths(dispatch)).toEqual(['/srv/notes.md'])
  })

  it('falls back to the read window length when the remote metadata omits a size', async () => {
    const { browse, dispatch } = await setup()
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.resolve') return { targetKey: '/srv/notes.md', displayPath: '/srv/notes.md' }
      if (method === 'fs.stat') return { version: 'v1', type: 'file' }
      if (method === 'fs.readRange') return Buffer.from('hello\n').toString('base64')
      throw new Error(`unexpected method ${method}`)
    })

    const contents = await browse.readFile({ path: '/srv/notes.md' }, new AbortController().signal)
    expect(contents).toMatchObject({ content: 'hello\n', size: 6, truncated: false })
  })

  it('skips a remote entry the explorer cannot act on', async () => {
    const { browse, dispatch } = await setup()
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.resolve') return { targetKey: '/srv', displayPath: '/srv' }
      if (method === 'fs.stat') return { version: 'v1', type: 'directory' }
      if (method === 'fs.list') {
        return [
          { name: 'socket', type: 'other', target: { targetKey: '/srv/socket', displayPath: '/srv/socket' } },
          { name: 'app', type: 'directory', target: { targetKey: '/srv/app', displayPath: '/srv/app' } },
        ]
      }
      throw new Error(`unexpected method ${method}`)
    })

    const listing = await browse.listFiles({ path: '/srv' }, new AbortController().signal)
    expect(listing.entries).toEqual([{ name: 'app', path: '/srv/app', kind: 'directory', hidden: false }])
  })

  it('names a thrown value that is not an Error', async () => {
    // Filesystem rejections may be anything; the wire failure still reports them.
    const throwing = {
      async resolve(): Promise<unknown> { return { targetKey: '/srv', displayPath: '/srv' } },
      async stat(): Promise<unknown> { return { version: 'v1', type: 'directory' } },
      async listDir(): Promise<unknown> { throw 'listing exploded' },
      processPath(target: { targetKey: unknown }): string { return String(target.targetKey) },
      processPathFromHostPath(): undefined { return undefined },
    } as unknown as FileSystem

    const browse = new WorkspaceFileBrowse(throwing, {})
    const failure = await browse.listFiles({ path: '/srv' }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    expect(failure).toMatchObject({ code: 'directory-unreadable' })
    expect(failure?.message).toContain('listing exploded')
  })

  it('maps a resolution failure to file-not-found and an aborted resolution to cancelled', async () => {
    const { browse, dispatch } = await setup()
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.resolve') throw new Error('cannot resolve')
      throw new Error(`unexpected method ${method}`)
    })
    await expect(browse.readFile({ path: '/srv/gone.md' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'file-not-found' })

    // Resolution failing because the caller departed is the caller's own reason.
    const abort = new AbortController()
    dispatch.mockImplementation(async (method, _params, signal) => {
      if (method === 'fs.resolve') {
        abort.abort()
        signal?.throwIfAborted()
      }
      throw new Error(`unexpected method ${method}`)
    })
    await expect(browse.readFile({ path: '/srv/gone.md' }, abort.signal))
      .rejects.toMatchObject({ code: 'cancelled' })
  })

  it('maps a remote read failure to file-unreadable and an aborted read to cancelled', async () => {
    const { browse, dispatch } = await setup()
    const metadata = async (method: string): Promise<unknown> => {
      if (method === 'fs.resolve') return { targetKey: '/srv/notes.md', displayPath: '/srv/notes.md' }
      if (method === 'fs.stat') return { version: 'v1', type: 'file', size: 6 }
      throw new Error(`unexpected method ${method}`)
    }
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.readRange') throw new Error('remote read failed')
      return await metadata(method)
    })
    await expect(browse.readFile({ path: '/srv/notes.md' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'file-unreadable' })

    // The same failure while the caller has departed is the caller's own reason.
    const abort = new AbortController()
    dispatch.mockImplementation(async (method, _params, signal) => {
      if (method === 'fs.readRange') {
        abort.abort()
        signal?.throwIfAborted()
      }
      return await metadata(method)
    })
    await expect(browse.readFile({ path: '/srv/notes.md' }, abort.signal))
      .rejects.toMatchObject({ code: 'cancelled' })
  })

  it('maps an unexpected listing failure to directory-unreadable', async () => {
    const { browse, dispatch } = await setup()
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.resolve') return { targetKey: '/srv', displayPath: '/srv' }
      if (method === 'fs.stat') return { version: 'v1', type: 'directory' }
      if (method === 'fs.list') throw new Error('listing exploded')
      throw new Error(`unexpected method ${method}`)
    })

    await expect(browse.listFiles({ path: '/srv' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'directory-unreadable', details: { path: '/srv' } })
  })

  it('reports binary content read over the remote world without decoding it', async () => {
    const { browse, dispatch } = await setup()
    dispatch.mockImplementation(async (method) => {
      if (method === 'fs.resolve') return { targetKey: '/srv/image.bin', displayPath: '/srv/image.bin' }
      if (method === 'fs.stat') return { version: 'v1', type: 'file', size: 3 }
      if (method === 'fs.readRange') return Buffer.from([0x01, 0x00, 0x02]).toString('base64')
      throw new Error(`unexpected method ${method}`)
    })

    const contents = await browse.readFile({ path: '/srv/image.bin' }, new AbortController().signal)

    expect(contents).toMatchObject({ path: '/srv/image.bin', content: '', size: 3, truncated: false, binary: true })
  })
})
