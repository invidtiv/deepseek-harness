import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FileListing } from '../src/types.ts'
import { WorkspaceFileBrowse } from '../src/file-browse.ts'

/** Harness root; realized paths must pass through realpathSync on macOS (/var → /private/var). */
function makeRoot(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `dsh-${prefix}-`)))
}
/** Failure payload of one verb call, asserting the wrap shape first. */
async function errorCode(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await promise
  } catch (error) {
    const failure = remoteErrorOf(error)
    expect(failure).toBeDefined()
    return failure as { code: string; details: unknown }
  }
  throw new Error('expected the call to fail')
}

describe('WorkspaceFileBrowse.listFiles', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('lists the default project root when the path is absent', async () => {
    const root = makeRoot('list-files-root')
    roots.push(root)
    mkdirSync(join(root, 'dirA'))
    mkdirSync(join(root, '.hidden-dir'))
    writeFileSync(join(root, 'b-file.txt'), '')
    writeFileSync(join(root, '.hidden-file'), '')

    const browse = new WorkspaceFileBrowse({ cwd: root })
    const listing = await browse.listFiles({}, new AbortController().signal)
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

    const browse = new WorkspaceFileBrowse({ cwd: '/definitely-not-the-requested-path' })
    const listing = await browse.listFiles({ path: join(root, 'parent') }, new AbortController().signal)
    expect(listing.path).toBe(join(root, 'parent'))
    expect(listing.entries).toEqual([
      { name: 'leaf.md', path: join(root, 'parent', 'leaf.md'), kind: 'file', hidden: false },
    ])
  })

  it('skips a broken symlink and resolves a live one to its target kind on POSIX', async () => {
    // Windows denies unprivileged file symlinks; the link cases run only where they can mount.
    if (process.platform === 'win32') return
    const root = makeRoot('list-files-link')
    roots.push(root)
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    symlinkSync(join(root, 'missing-target'), join(root, 'broken'))

    const browse = new WorkspaceFileBrowse({ cwd: root })
    const listing = await browse.listFiles({ path: root }, new AbortController().signal)
    // No explorer action can act on a broken link, so it is skipped silently
    // (the browse listing's broken-link policy).
    expect(listing.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['link', 'directory'],
      ['real', 'directory'],
    ])
  })

  it('errors with the shared listing code on a non-directory target', async () => {
    const root = makeRoot('list-files-nondir')
    roots.push(root)
    const file = join(root, 'plain.txt')
    writeFileSync(file, '')

    const browse = new WorkspaceFileBrowse({ cwd: root })
    expect(await errorCode(browse.listFiles({ path: file }, new AbortController().signal))).toMatchObject({
      code: 'directory-unreadable',
      details: { path: file },
    })
  })

  it('errors with the shared listing code on a missing target', async () => {
    const root = makeRoot('list-files-missing')
    roots.push(root)
    const missing = join(root, 'absent')

    const browse = new WorkspaceFileBrowse({ cwd: root })
    expect(await errorCode(browse.listFiles({ path: missing }, new AbortController().signal))).toMatchObject({
      code: 'directory-unreadable',
      details: { path: missing },
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

    const browse = new WorkspaceFileBrowse({ cwd: root })
    const listing: FileListing = await browse.listFiles({ path: root }, new AbortController().signal)
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
    const browse = new WorkspaceFileBrowse({ cwd: root })
    expect(await errorCode(browse.listFiles({ path: root }, abort.signal))).toMatchObject({
      code: 'cancelled',
    })
  })
})

describe('WorkspaceFileBrowse.readFile', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('reads a text file with its byte size and no flags', async () => {
    const root = makeRoot('read-file-text')
    roots.push(root)
    const file = join(root, 'notes.txt')
    writeFileSync(file, 'héllo\n')

    const browse = new WorkspaceFileBrowse({ cwd: root })
    const contents = await browse.readFile({ path: file }, new AbortController().signal)
    expect(contents).toEqual({ path: file, content: 'héllo\n', size: 7, truncated: false, binary: false })
  })

  it('refuses binary content with empty text', async () => {
    const root = makeRoot('read-file-binary')
    roots.push(root)
    const file = join(root, 'blob.bin')
    writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]))

    const browse = new WorkspaceFileBrowse({ cwd: root })
    const contents = await browse.readFile({ path: file }, new AbortController().signal)
    expect(contents.binary).toBe(true)
    expect(contents.content).toBe('')
    expect(contents.size).toBe(3)
  })

  it('returns a truncated prefix for files past the read bound', async () => {
    const root = makeRoot('read-file-truncated')
    roots.push(root)
    const file = join(root, 'large.txt')
    // One byte over the 2 MiB read cap: the prefix is capped, the flag proves over-read.
    writeFileSync(file, 'a'.repeat(2 * 1024 * 1024 + 1))

    const browse = new WorkspaceFileBrowse({ cwd: root })
    const contents = await browse.readFile({ path: file }, new AbortController().signal)
    expect(contents.truncated).toBe(true)
    expect(contents.content.length).toBe(2 * 1024 * 1024)
    expect(contents.size).toBe(2 * 1024 * 1024 + 1)
  })

  it('maps a missing file and a directory onto their own codes', async () => {
    const root = makeRoot('read-file-errors')
    roots.push(root)
    const dir = join(root, 'folder')
    mkdirSync(dir)

    const browse = new WorkspaceFileBrowse({ cwd: root })
    expect(await errorCode(browse.readFile({ path: join(root, 'absent') }, new AbortController().signal)))
      .toMatchObject({ code: 'file-not-found', details: { path: join(root, 'absent') } })
    expect(await errorCode(browse.readFile({ path: dir }, new AbortController().signal)))
      .toMatchObject({ code: 'file-unreadable', details: { path: dir } })
  })
})
