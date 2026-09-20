/** Behavior of the browse backend over the composed filesystem and a named SSH environment. */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker, { fullyQualified } from '../src/index.ts'

let root: string
let capability: DirectoryPickerBrowseCapability
let dispose: () => Promise<void>

/** A filesystem with no host path mapping, like a remote execution world. */
class RemoteFileSystem extends LocalFileSystem {
  override processPathFromHostPath(): string | undefined { return undefined }
}

/** Boot the browse backend beside a local filesystem and return its capability. */
async function browsePlugin(maxEntries?: number): Promise<{ capability: DirectoryPickerBrowseCapability; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  const fiber = maxEntries === undefined
    ? ctx.plugin(BrowseDirectoryPicker)
    : ctx.plugin(BrowseDirectoryPicker, { maxEntries })
  await fiber
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  return { capability: picked, dispose: () => fiber.dispose() }
}

/** One remote level the fake broker answers, in the broker's own vocabulary. */
const REMOTE_LEVEL = {
  path: '/srv/app',
  home: '/home/alice',
  crumbs: [{ name: '/', path: '/' }, { name: 'srv', path: '/srv' }, { name: 'app', path: '/srv/app' }],
  entries: [{ name: 'src', path: '/srv/app/src' }, { name: '.secret', path: '/srv/app/.secret' }],
}

/** Boot the browse backend over a fake SSH broker that records each request. */
async function brokerPlugin(options: { maxEntries?: number; failList?: boolean; failCreate?: boolean } = {}): Promise<{
  capability: DirectoryPickerBrowseCapability
  dispose: () => Promise<void>
  calls: Array<{ method: string; environmentId: string; path?: string; name?: string }>
}> {
  const calls: Array<{ method: string; environmentId: string; path?: string; name?: string }> = []
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  ctx.provide('sshBroker', {
    listDirectory: (environmentId: string, path?: string) => {
      calls.push({ method: 'list', environmentId, ...(path === undefined ? {} : { path }) })
      if (options.failList === true) return Promise.reject(new Error('remote scan failed'))
      return Promise.resolve(REMOTE_LEVEL)
    },
    createDirectory: (environmentId: string, path: string, name: string) => {
      calls.push({ method: 'create', environmentId, path, name })
      if (options.failCreate === true) return Promise.reject(new Error('remote create failed'))
      return Promise.resolve(`${path}/${name}`)
    },
  })
  const fiber = options.maxEntries === undefined
    ? ctx.plugin(BrowseDirectoryPicker)
    : ctx.plugin(BrowseDirectoryPicker, { maxEntries: options.maxEntries })
  await fiber
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  return { capability: picked, dispose: () => fiber.dispose(), calls }
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-browse-')))
  await mkdir(join(root, 'projects'))
  await mkdir(join(root, 'projects', 'harness'))
  await mkdir(join(root, '.hidden-dir'))
  await writeFile(join(root, 'notes.txt'), 'not a directory')
  await symlink(join(root, 'projects'), join(root, 'linked'), 'junction')
  await symlink(join(root, 'gone'), join(root, 'broken'), 'junction')
  try {
    // Windows denies unprivileged file symlinks; the row is filtered anyway.
    await symlink(join(root, 'notes.txt'), join(root, 'file-link'))
  } catch { /* The file-link row only feeds the POSIX lanes. */ }
  const booted = await browsePlugin()
  capability = booted.capability
  dispose = booted.dispose
})

afterAll(async () => {
  await dispose()
  await rm(root, { recursive: true, force: true })
})

describe('BrowseDirectoryPicker', () => {
  it('lists directories only, flags hidden rows, follows symlinks, skips broken links, sorts by name', async () => {
    const listing = await capability.list(root)
    expect(listing.path).toBe(root)
    expect(listing.home).toBe(homedir())
    expect(listing.entries.map(entry => entry.name)).toEqual(['.hidden-dir', 'linked', 'projects'])
    expect(listing.entries.map(entry => entry.hidden)).toEqual([true, false, false])
    // Every entry path is absolute — clients never join segments.
    expect(listing.entries.every(entry => entry.path === join(root, entry.name))).toBe(true)
    expect(listing.truncated).toBe(false)
  })

  it('cuts a level at maxEntries keeping the name-sorted head, and flags the cut', async () => {
    const bounded = await browsePlugin(1)
    try {
      const cut = await bounded.capability.list(root)
      expect(cut.entries.map(entry => entry.name)).toEqual(['.hidden-dir'])
      expect(cut.truncated).toBe(true)
      // Exactly at the bound is complete, not truncated.
      const exact = await bounded.capability.list(join(root, 'projects'))
      expect(exact.entries.map(entry => entry.name)).toEqual(['harness'])
      expect(exact.truncated).toBe(false)
      await mkdir(join(root, 'projects', 'harness', 'a'))
      await mkdir(join(root, 'projects', 'harness', 'b'))
      const beyond = await bounded.capability.list(join(root, 'projects', 'harness'))
      expect(beyond.entries.map(entry => entry.name)).toEqual(['a'])
      expect(beyond.truncated).toBe(true)
    } finally {
      await bounded.dispose()
    }
  })

  it('stops with the caller: an aborted signal rejects with its own reason', async () => {
    const gone = new AbortController()
    gone.abort(new Error('caller left'))
    // The abort surfaces as-is, not dressed as an unreadable directory.
    await expect(capability.list(root, gone.signal)).rejects.toThrow('caller left')
    await expect(capability.list(join(root, 'no-such-dir'), gone.signal)).rejects.toThrow('caller left')
    // A live signal leaves a normal listing untouched.
    const live = new AbortController()
    const complete = await capability.list(root, live.signal)
    expect(complete.truncated).toBe(false)
    expect(complete.entries.map(entry => entry.name)).toContain('linked')
  })

  it('reports the ancestry as jump-target crumbs ending at the listed directory', async () => {
    const listing = await capability.list(join(root, 'projects'))
    const tail = listing.crumbs.at(-1)!
    expect(tail).toMatchObject({ name: 'projects', path: join(root, 'projects'), hidden: false })
    expect(listing.crumbs.at(-2)!.path).toBe(root)
    expect(listing.crumbs.at(-2)!.name).toBe(basename(root))
    // The chain starts at the filesystem root, whose crumb is labeled by its full path.
    expect(listing.crumbs[0]!.name).toBe(listing.crumbs[0]!.path)
  })

  it('lists the home directory when no path is given', async () => {
    const listing = await capability.list()
    expect(listing.path).toBe(homedir())
    expect(listing.home).toBe(homedir())
  })

  it('reports a missing target with the shared listing code and its path', async () => {
    const missing = join(root, 'no-such-dir')
    const failure = await capability.list(missing).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    expect((failure as DirectoryPickerError).path).toBe(missing)
  })

  it('reports a non-directory target with the shared listing code', async () => {
    const file = join(root, 'notes.txt')
    const failure = await capability.list(file).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    expect((failure as DirectoryPickerError).path).toBe(file)
  })

  it('classifies fully qualified paths per platform (drive-less rooted Windows forms rejected)', () => {
    expect(fullyQualified('/home/x', 'linux')).toBe(true)
    expect(fullyQualified('x/y', 'darwin')).toBe(false)
    expect(fullyQualified('C:\\projects', 'win32')).toBe(true)
    expect(fullyQualified('C:/projects', 'win32')).toBe(true)
    expect(fullyQualified('\\\\server\\share', 'win32')).toBe(true)
    expect(fullyQualified('//server/share/deep', 'win32')).toBe(true)
    expect(fullyQualified('\\foo', 'win32')).toBe(false)
    expect(fullyQualified('/foo', 'win32')).toBe(false)
    expect(fullyQualified('C:relative', 'win32')).toBe(false)
    expect(fullyQualified('\\\\', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server\\', 'win32')).toBe(false)
  })

  it('accepts a fully qualified Windows path instead of rejecting it as relative', async () => {
    const failure = await capability.list('C:\\dsh-browse-absent').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
  })

  it('rejects non-absolute paths instead of rebasing them under the process cwd', async () => {
    for (const relative of ['', 'projects', './projects', '..']) {
      const listFailure = await capability.list(relative).catch((error: unknown) => error)
      expect(listFailure).toBeInstanceOf(DirectoryPickerError)
      expect((listFailure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((listFailure as DirectoryPickerError).path).toBe(relative)
      const createFailure = await capability.createDirectory(relative, 'child').catch((error: unknown) => error)
      expect(createFailure).toBeInstanceOf(DirectoryPickerError)
      expect((createFailure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((createFailure as DirectoryPickerError).path).toBe(relative)
    }
  })

  it('creates one child directory and surfaces it in the next listing', async () => {
    const created = await capability.createDirectory(root, 'fresh')
    expect(created).toBe(join(root, 'fresh'))
    const listing = await capability.list(root)
    expect(listing.entries.map(entry => entry.name)).toContain('fresh')
  })

  it('refuses an existing child with directory-exists', async () => {
    const failure = await capability.createDirectory(root, 'projects').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-exists')
  })

  it('refuses non-segment names and other filesystem failures with directory-create-failed', async () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
      const failure = await capability.createDirectory(root, name).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
    }
    const missingParent = await capability.createDirectory(join(root, 'no-such-dir'), 'child').catch((error: unknown) => error)
    expect((missingParent as DirectoryPickerError).code).toBe('directory-create-failed')
  })

  it('browses a non-process-local world and creates there through the composed filesystem', async () => {
    const ctx = new Context()
    await ctx.plugin(RemoteFileSystem)
    const fiber = ctx.plugin(BrowseDirectoryPicker)
    await fiber
    const picked = ctx.get('directoryPicker')!.capability()
    if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      // No host path maps into this world, so the filesystem root stands in for home.
      const listing = await picked.list(root)
      expect(listing.home).toBe('/')
      // Creation targets the composed filesystem, not a host path.
      expect(await picked.createDirectory(root, 'remote-child')).toBe(join(root, 'remote-child'))
      const next = await picked.list(root)
      expect(next.entries.map(entry => entry.name)).toContain('remote-child')
      await rm(join(root, 'remote-child'), { recursive: true, force: true })
    } finally {
      await fiber.dispose()
    }
  })
})

describe('BrowseDirectoryPicker over a named SSH environment', () => {
  it('lists through the broker and keeps the remote host spelling', async () => {
    const remote = await brokerPlugin()
    try {
      const listing = await remote.capability.listIn!('bsdev', '/srv/app')
      expect(listing).toMatchObject({ path: '/srv/app', home: '/home/alice', truncated: false })
      expect(listing.entries).toEqual([
        { name: 'src', path: '/srv/app/src', hidden: false },
        { name: '.secret', path: '/srv/app/.secret', hidden: true },
      ])
      expect(listing.crumbs.map(crumb => crumb.path)).toEqual(['/', '/srv', '/srv/app'])
      expect(remote.calls).toEqual([{ method: 'list', environmentId: 'bsdev', path: '/srv/app' }])
    } finally {
      await remote.dispose()
    }
  })

  it('lists the environment workspace when the request carries no path', async () => {
    const remote = await brokerPlugin()
    try {
      await remote.capability.listIn!('bsdev')
      expect(remote.calls).toEqual([{ method: 'list', environmentId: 'bsdev' }])
    } finally {
      await remote.dispose()
    }
  })

  it('bounds a remote level at maxEntries', async () => {
    const remote = await brokerPlugin({ maxEntries: 1 })
    try {
      const listing = await remote.capability.listIn!('bsdev', '/srv/app')
      expect(listing.entries).toEqual([{ name: 'src', path: '/srv/app/src', hidden: false }])
      expect(listing.truncated).toBe(true)
    } finally {
      await remote.dispose()
    }
  })

  it('creates in the environment through the broker', async () => {
    const remote = await brokerPlugin()
    try {
      expect(await remote.capability.createDirectoryIn!('bsdev', '/srv/app', 'new')).toBe('/srv/app/new')
    } finally {
      await remote.dispose()
    }
  })

  it('reports remote listing and creation failures with the shared codes', async () => {
    const listing = await brokerPlugin({ failList: true })
    try {
      const failure = await listing.capability.listIn!('bsdev', '/srv/app').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((failure as DirectoryPickerError).path).toBe('/srv/app')
    } finally {
      await listing.dispose()
    }

    const creating = await brokerPlugin({ failCreate: true })
    try {
      const failure = await creating.capability.createDirectoryIn!('bsdev', '/srv/app', 'new')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((failure as DirectoryPickerError).path).toBe(join('/srv/app', 'new'))
    } finally {
      await creating.dispose()
    }
  })

  it('refuses an environment when the deployment composes no broker', async () => {
    const booted = await browsePlugin()
    try {
      const failure = await booted.capability.listIn!('bsdev', '/srv/app').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    } finally {
      await booted.dispose()
    }
  })
})
