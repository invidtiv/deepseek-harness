/**
 * The mixed execution world end to end: the SSH filesystem is the composition's
 * `ctx.fs` and serves a host path through the local world composed beneath it,
 * while a path a registered SSH workspace claims stays on its connection.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { SshWorlds, type SshWorldConnection } from '@deepseek-ai/dsh-ssh'
import * as localWorld from '@deepseek-ai/dsh-ssh/local-world'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshFileSystem } from '../src/index.ts'

const REMOTE_ROOT = '/srv/project'

/** The shared file-effect policy every provider resolves. */
class Policy extends Service {
  readonly defaultMode = 'workspace-write'
  constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
  resolve(): { mode: 'workspace-write'; workspaceRoot: string } {
    return { mode: 'workspace-write', workspaceRoot: process.cwd() }
  }
}

/** A remote connection stub answering the filesystem methods this spec exercises. */
function remoteConnection() {
  const calls: string[] = []
  const dispatch = vi.fn(async (method: string, params: unknown) => {
    if (method === 'fs.resolve') {
      const path = (params as { path: string }).path
      return { targetKey: path, displayPath: path }
    }
    if (method === 'fs.stat') return { version: 'r1', type: 'directory' }
    if (method === 'fs.readText') return 'remote body'
    if (method === 'fs.mkdir') return null
    throw new Error(`unexpected remote method ${method}`)
  })
  const connection: SshWorldConnection & { calls: string[]; dispatch: typeof dispatch } = {
    calls,
    dispatch,
    request: async <T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> => {
      calls.push(method)
      return schema.parse(await dispatch(method, params))
    },
    connectStream: () => Promise.reject(new Error('no stream in this spec')),
    dispose: () => Promise.resolve(),
  }
  return connection
}

/** Boot the mixed world: SSH providers over a local world and one remote world. */
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mixed-world-'))
  const localFile = join(root, 'notes.txt')
  writeFileSync(localFile, 'local body\n')
  const remote = remoteConnection()

  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  await ctx.plugin(Policy)
  ctx.provide('workspaceRegistry', {
    list: () => [{ transport: 'ssh' as const, environmentId: 'build01', path: REMOTE_ROOT }],
  } as never)
  await ctx.plugin(SshWorlds)
  await ctx.plugin(localWorld)
  ctx.sshWorlds.register('build01', remote)
  await ctx.plugin(SshFileSystem)
  return { fs: ctx.fs, localFile, remote }
}

describe('mixed execution world', () => {
  it('serves a host path from the local world composed beneath the SSH filesystem', async () => {
    const { fs, localFile } = await harness()

    expect(fs.addressesHostFilesystem).toBe(true)
    const target = await fs.resolve(localFile)
    expect(fs.processPath(target)).toBe(localFile)
    expect(await fs.readText(target)).toBe('local body\n')
    expect(fs.fileUrl(target)).toBe(pathToFileURL(localFile).href)
  })

  it('keeps a path a registered SSH workspace claims on its connection', async () => {
    const { fs, remote } = await harness()

    const target = await fs.resolve(`${REMOTE_ROOT}/notes.txt`)
    expect(await fs.readText(target)).toBe('remote body')
    expect(remote.calls).toEqual(['fs.resolve', 'fs.readText'])
    // The world identity stays host-side; the wire sees the remote path alone.
    expect(String(target.targetKey)).not.toBe(`${REMOTE_ROOT}/notes.txt`)
  })

  it('creates a remote directory under the named environment through its own connection', async () => {
    const { fs, remote } = await harness()

    const target = await fs.resolve(`${REMOTE_ROOT}/fresh`, { environmentId: 'build01' })
    await fs.mkdir(target, undefined, { mode: 'danger-full-access', workspaceRoot: REMOTE_ROOT })

    expect(remote.calls).toEqual(['fs.resolve', 'fs.mkdir'])
    expect(remote.dispatch).toHaveBeenLastCalledWith('fs.mkdir', expect.objectContaining({
      target: { targetKey: `${REMOTE_ROOT}/fresh`, displayPath: `${REMOTE_ROOT}/fresh` },
      policy: { mode: 'danger-full-access', workspaceRoot: REMOTE_ROOT },
    }))
  })
})
