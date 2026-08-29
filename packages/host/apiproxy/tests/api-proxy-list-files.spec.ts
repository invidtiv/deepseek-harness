import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { FileListing } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`list-files-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

/** Harness root; realized paths must pass through realpathSync on macOS (/var → /private/var). */
function makeRoot(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `dsh-${prefix}-`)))
}

describe('host.listFiles', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function harness(cwd: string) {
    // UserQuestionService is the one construction-time requirement of
    // createApiProxy; the filesystem domain touches nothing else.
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    return createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
      cwd,
    })
  }

  it('lists the default project root when the path is absent', async () => {
    const root = makeRoot('list-files-root')
    roots.push(root)
    mkdirSync(join(root, 'dirA'))
    mkdirSync(join(root, '.hidden-dir'))
    writeFileSync(join(root, 'b-file.txt'), '')
    writeFileSync(join(root, '.hidden-file'), '')

    const api = await harness(root)
    const listing = expectOk(await api.host.listFiles(request({}), new AbortController().signal))
    expect(listing.path).toBe(root)
    expect(listing.truncated).toBe(false)
    expect(listing.entries).toEqual([
      { name: '.hidden-dir', path: join(root, '.hidden-dir'), kind: 'directory', hidden: true },
      { name: '.hidden-file', path: join(root, '.hidden-file'), kind: 'file', hidden: true },
      { name: 'b-file.txt', path: join(root, 'b-file.txt'), kind: 'file', hidden: false },
      { name: 'dirA', path: join(root, 'dirA'), kind: 'directory', hidden: false },
    ])
  })

  it('lists an explicit sublevel with absolute entry paths', async () => {
    const root = makeRoot('list-files-sub')
    roots.push(root)
    mkdirSync(join(root, 'parent'))
    writeFileSync(join(root, 'parent', 'leaf.md'), '')

    const api = await harness('/definitely-not-the-requested-path')
    const listing = expectOk(await api.host.listFiles(
      request({ path: join(root, 'parent') }), new AbortController().signal,
    ))
    expect(listing.path).toBe(join(root, 'parent'))
    expect(listing.entries).toEqual([
      { name: 'leaf.md', path: join(root, 'parent', 'leaf.md'), kind: 'file', hidden: false },
    ])
  })

  it('resolves symlinked directories to directory rows on POSIX', async () => {
    // Windows denies unprivileged file symlinks; the link cases run only where they can mount.
    if (process.platform === 'win32') return
    const root = makeRoot('list-files-link')
    roots.push(root)
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    symlinkSync(join(root, 'missing-target'), join(root, 'broken'))

    const api = await harness(root)
    const listing = expectOk(await api.host.listFiles(request({ path: root }), new AbortController().signal))
    expect(listing.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['broken', 'file'],
      ['link', 'directory'],
      ['real', 'directory'],
    ])
  })

  it('errors with the shared listing code on a non-directory target', async () => {
    const root = makeRoot('list-files-nondir')
    roots.push(root)
    const file = join(root, 'plain.txt')
    writeFileSync(file, '')

    const api = await harness(root)
    expect((await api.host.listFiles(request({ path: file }), new AbortController().signal)).result).toMatchObject({
      ok: false,
      error: { code: 'directory-unreadable', details: { path: file } },
    })
  })

  it('errors with the shared listing code on a missing target', async () => {
    const root = makeRoot('list-files-missing')
    roots.push(root)
    const missing = join(root, 'absent')

    const api = await harness(root)
    expect((await api.host.listFiles(request({ path: missing }), new AbortController().signal)).result).toMatchObject({
      ok: false,
      error: { code: 'directory-unreadable', details: { path: missing } },
    })
  })

  it('keeps the name-sorted head when a level exceeds the bound and flags truncation', async () => {
    const root = makeRoot('list-files-bounded')
    roots.push(root)
    // Descending creation order exercises both bound branches per candidate:
    // every late arrival inserts before the tail and evicts it, then the tail
    // reject path takes over for names beyond the kept head.
    for (let index = 1005; index >= 0; index--) {
      writeFileSync(join(root, `n${String(index).padStart(4, '0')}`), '')
    }

    const api = await harness(root)
    const listing: FileListing = expectOk(await api.host.listFiles(request({ path: root }), new AbortController().signal))
    expect(listing.truncated).toBe(true)
    expect(listing.entries.length).toBe(1000)
    expect(listing.entries[0]?.name).toBe('n0000')
    expect(listing.entries.at(-1)?.name).toBe('n0999')
  })

  it('reports cancelled when the caller departs mid-scan', async () => {
    const root = makeRoot('list-files-abort')
    roots.push(root)

    const abort = new AbortController()
    abort.abort()
    const api = await harness(root)
    expect((await api.host.listFiles(request({ path: root }), abort.signal)).result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})
