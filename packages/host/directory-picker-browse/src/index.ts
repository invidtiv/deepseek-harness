/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability — one-level directory listing and child-directory
 * creation over the composed execution world. Listing reads through `ctx.fs`,
 * so an SSH-backed deployment browses the remote filesystem; a non-process-local
 * world is refused for creation until an unfenced execution-world create path
 * exists. Nothing renders on the host display, so this backend serves remote
 * clients the dialog backend cannot. Policy decisions (hidden entries flagged
 * but returned, symlink targets followed by the provider, whole-filesystem
 * scope) are recorded in the directory-picker seam Agent Note.
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import { homedir } from 'node:os'
import { basename, dirname, join, posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves the `ctx.fs` service this backend reads through.
import type {} from '@deepseek-ai/dsh-fs'
import {
  DirectoryPicker, DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing, DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less
 * forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`)
 * pass `isAbsolute` yet still resolve against the process's current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/**
 * Whether a wire path is absolute in the execution world: POSIX-absolute, or a
 * fully qualified Windows path. A relative value must never rebase under the
 * host process cwd or, on Windows, its current drive.
 * @param path - candidate path.
 * @returns whether the path is absolute in either world.
 */
function absoluteInWorld(path: string): boolean {
  return posix.isAbsolute(path) || fullyQualified(path, 'win32')
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- the filesystem and node:fs reject with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
}

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  static inject = ['fs']

  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many child-directory rows
   * (hidden rows included), with `truncated` flagging a cut level. The
   * default follows GitHub's web UI, which truncates directory listings at
   * 1,000 entries.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
  })

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    // The seam contract takes absolute paths only; a relative or empty wire
    // value must not resolve against the host cwd.
    if (path !== undefined && !absoluteInWorld(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not an absolute path`)
    }
    // The execution world's home when the composed filesystem is process-local;
    // a remote world has no host home, so the root is the safe default.
    const home = this.ctx.fs.processPathFromHostPath(homedir()) ?? '/'
    const requested = path ?? home
    try {
      const target = await this.ctx.fs.resolve(requested, signal === undefined ? {} : { signal })
      const info = await this.ctx.fs.stat(target, signal)
      if (info === undefined || info.type !== 'directory') throw new Error('not a directory')
      const directory = this.ctx.fs.processPath(target)
      const listed = await this.ctx.fs.listDir(target, signal)
      // Only rows a browser could enter; the provider already resolved
      // symlinks, so a live link lists at its target's kind and a broken one
      // is skipped. The name-sorted head is kept under the configured bound.
      const entries: DirectoryEntry[] = []
      let truncated = false
      for (const entry of [...listed].sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.type !== 'directory') continue
        if (entries.length === this.config.maxEntries) {
          truncated = true
          break
        }
        entries.push({ name: entry.name, path: entry.target.displayPath, hidden: entry.name.startsWith('.') })
      }
      return { path: directory, home, crumbs: ancestryCrumbs(directory), entries, truncated }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', requested, `cannot list ${requested}: ${messageOf(error)}`)
    }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    // Same absolute fence as list: never rebase a parent under the cwd.
    if (!absoluteInWorld(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not an absolute parent path`)
    }
    // The backend owns segment validation; the Remote controller also refuses
    // invalid wire input, but direct service consumers must hit the same fence.
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(path, name), `"${name}" is not a single path segment`)
    }
    const parent = this.ctx.fs.processPath(await this.ctx.fs.resolve(path))
    // Build the child through the provider so a remote world's separator and
    // canonical spelling are its own, not the host's.
    const child = await this.ctx.fs.resolve(name, { cwd: parent })
    const target = this.ctx.fs.processPath(child)
    try {
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent. The
      // operator's own directory choice is not an agent file effect, so it is
      // created unfenced regardless of the deployment's agent sandbox.
      await this.ctx.fs.mkdir(child, undefined, { mode: 'danger-full-access', workspaceRoot: parent })
      return target
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_ALREADY_EXISTS') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }
}
