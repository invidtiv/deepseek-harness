/** Workspace file verbs for the Web GUI's file explorer and viewer: bounded reads and mixed listings over the composed filesystem. */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {
  FileContents, FileListing, FileListingEntry, FileListRequest, FileReadRequest,
} from './types.ts'

/** Maximum file bytes the in-app file viewer reads; larger files return a truncated prefix. */
const READ_FILE_MAX_BYTES = 2 * 1024 * 1024

/**
 * Complete-result bound of one file-explorer listing level; a bigger level is
 * cut with `truncated`. Follows the browse listing's bound (1,000 rows).
 */
const LIST_FILES_MAX_ENTRIES = 1000

/** Configuration of the workspace file verbs; every field has a production default. */
export interface WorkspaceFileBrowseConfig {
  /**
   * Project root an absent {@link FileListRequest.path} lists — the cwd an
   * unspecified-cwd session starts from. Omitted maps the Host process cwd into
   * the composed filesystem's execution world, or that world's root when it
   * cannot read host files.
   */
  readonly cwd?: string
}

/**
 * Implements the workspace file verbs over the composed filesystem, so the Web
 * file explorer and viewer read the same execution world the agent tools do.
 * Reads are binary-refusing and bounded; listings keep the name-sorted head
 * under a fixed row bound. Failures map onto the stable wire codes
 * `file-not-found`, `file-unreadable`, `directory-unreadable`, and
 * `cancelled`.
 */
export class WorkspaceFileBrowse {
  readonly #cwd: string

  /**
   * @param fs - the composed filesystem the explorer and viewer read through.
   * @param config - project root for absent listing paths; omitted resolves the
   *   Host process cwd in this filesystem's execution world.
   */
  constructor(private readonly fs: FileSystem, config: WorkspaceFileBrowseConfig = {}) {
    // A remote world cannot read the Host cwd, so map it through the provider and
    // fall back to the world root: an absent listing path must never name a host
    // path the viewer's filesystem cannot serve.
    this.#cwd = config.cwd ?? fs.processPathFromHostPath(process.cwd()) ?? '/'
  }

  /**
   * Read one text file's contents for the file viewer, bounded and
   * binary-refusing: a missing path, a directory, and a read failure each
   * become their own wire failure, a file too large to show whole returns a
   * truncated prefix, and a non-text file returns `binary` with empty
   * content. Reading at most one byte past the cap proves truncation without
   * loading the whole file into memory.
   * @param request - the read request.
   * @param signal - caller/connection lifetime.
   * @returns the file contents.
   */
  async readFile(request: FileReadRequest, signal: AbortSignal): Promise<FileContents> {
    const path = request.path
    let target: Awaited<ReturnType<FileSystem['resolve']>>
    let info: Awaited<ReturnType<FileSystem['stat']>>
    try {
      target = await this.fs.resolve(path, { signal })
      info = await this.fs.stat(target, signal)
    } catch {
      if (signal.aborted) throw new RemoteError('cancelled', 'file read was aborted', { path })
      throw new RemoteError('file-not-found', `file "${path}" was not found`, { path })
    }
    if (info === undefined) throw new RemoteError('file-not-found', `file "${path}" was not found`, { path })
    if (info.type === 'directory') throw new RemoteError('file-unreadable', `"${path}" is a directory`, { path })
    try {
      // One byte past the cap distinguishes "exactly the cap" from "over the cap".
      const bounded = await this.fs.readByteRange(target, { offset: 0, length: READ_FILE_MAX_BYTES + 1 }, signal)
      const window = bounded.subarray(0, Math.min(bounded.length, READ_FILE_MAX_BYTES))
      const binary = window.includes(0)
      return {
        path,
        content: binary ? '' : Buffer.from(window).toString('utf8'),
        size: info.size ?? bounded.length,
        truncated: bounded.length > READ_FILE_MAX_BYTES,
        binary,
      }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('cancelled', 'file read was aborted', { path })
      throw new RemoteError('file-unreadable', `file "${path}" could not be read: ${fsMessage(error)}`, { path })
    }
  }

  /**
   * List one mixed directory level (child directories and files) for the file
   * explorer, bounded at {@link LIST_FILES_MAX_ENTRIES}. The provider resolves
   * symlinks, so a live link lists at its target's kind and a broken one is
   * skipped. An unreadable or missing level — including a non-directory target
   * — maps onto the shared listing failure.
   * @param request - the listing request.
   * @param signal - caller/connection lifetime; abort stops the scan instead
   *   of letting it outlive a disconnected caller.
   * @returns the mixed listing.
   */
  async listFiles(request: FileListRequest, signal: AbortSignal): Promise<FileListing> {
    const requested = request.path ?? this.#cwd
    try {
      const target = await this.fs.resolve(requested, { signal })
      const directory = this.fs.processPath(target)
      const info = await this.fs.stat(target, signal)
      if (info === undefined || info.type !== 'directory') {
        throw new RemoteError('directory-unreadable', `"${directory}" is not a directory`, { path: directory })
      }
      const listed = await this.fs.listDir(target, signal)
      const rows: FileListingEntry[] = []
      let truncated = false
      for (const entry of [...listed].sort((left, right) => left.name.localeCompare(right.name))) {
        // Broken/cyclic links and special files have no explorer action.
        if (entry.type === 'other') continue
        if (rows.length >= LIST_FILES_MAX_ENTRIES) { truncated = true; break }
        rows.push({
          name: entry.name,
          path: entry.target.displayPath,
          kind: entry.type === 'directory' ? 'directory' : 'file',
          hidden: entry.name.startsWith('.'),
        })
      }
      return { path: directory, entries: rows, truncated }
    } catch (error: unknown) {
      if (remoteErrorOf(error) !== undefined) throw error
      if (signal.aborted) throw new RemoteError('cancelled', 'directory listing was aborted', {})
      throw new RemoteError('directory-unreadable', `cannot list "${requested}": ${fsMessage(error)}`, { path: requested })
    }
  }
}

/** Message text of an unknown thrown value (filesystem rejections may be anything). */
function fsMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
