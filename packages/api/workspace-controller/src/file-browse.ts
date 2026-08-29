/** Workspace file verbs for the Web GUI's file explorer and viewer: bounded reads and mixed listings over the Host filesystem. */

import { open, opendir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
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
   * unspecified-cwd session starts from.
   */
  readonly cwd?: string
}

/**
 * Implements the workspace file verbs against the Host filesystem. Reads are
 * binary-refusing and capped; listings stream once and keep the name-sorted
 * head under a fixed bound. Failures map onto the stable wire codes
 * `file-not-found`, `file-unreadable`, `directory-unreadable`, and
 * `cancelled`.
 */
export class WorkspaceFileBrowse {
  readonly #cwd: string

  /** @param config - project root for absent listing paths; defaults to the Host process cwd. */
  constructor(config: WorkspaceFileBrowseConfig = {}) {
    this.#cwd = config.cwd ?? process.cwd()
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
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch {
      throw new TypertRemoteFailure({
        code: 'file-not-found',
        message: `file "${path}" was not found`,
        details: { path },
      })
    }
    if (info.isDirectory()) {
      throw new TypertRemoteFailure({
        code: 'file-unreadable',
        message: `"${path}" is a directory`,
        details: { path },
      })
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, 'r')
      // One byte past the cap distinguishes "exactly the cap" from "over the cap".
      const readLength = Math.min(info.size, READ_FILE_MAX_BYTES + 1)
      const buffer = Buffer.alloc(readLength)
      const { bytesRead } = await handle.read(buffer, 0, readLength, 0)
      const bounded = buffer.subarray(0, Math.min(bytesRead, READ_FILE_MAX_BYTES))
      const binary = bounded.includes(0)
      const content = binary ? '' : bounded.toString('utf8')
      return {
        path,
        content,
        size: info.size,
        truncated: bytesRead > READ_FILE_MAX_BYTES,
        binary,
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new TypertRemoteFailure({ code: 'cancelled', message: 'file read was aborted', details: { path } })
      }
      throw new TypertRemoteFailure({
        code: 'file-unreadable',
        message: `file "${path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
        details: { path },
      })
    } finally {
      await handle?.close()
    }
  }

  /**
   * List one mixed directory level (child directories and files) for the file
   * explorer, bounded at {@link LIST_FILES_MAX_ENTRIES}: dirents stream once,
   * symlink targets probe per row, and the answer keeps the name-sorted head
   * plus the `truncated` flag. An unreadable or missing level — including a
   * non-directory target — maps onto the shared listing failure.
   * @param request - the listing request.
   * @param signal - caller/connection lifetime; abort stops the scan instead
   *   of letting it outlive a disconnected caller.
   * @returns the mixed listing.
   */
  async listFiles(request: FileListRequest, signal: AbortSignal): Promise<FileListing> {
    // Absent path lists the default project root — the cwd an unspecified-cwd
    // session starts from.
    const target = resolve(request.path ?? this.#cwd)
    let dir: Awaited<ReturnType<typeof opendir>> | undefined
    let closed = false
    try {
      if (!(await stat(target)).isDirectory()) {
        throw new TypertRemoteFailure({
          code: 'directory-unreadable',
          message: `"${target}" is not a directory`,
          details: { path: target },
        })
      }
      const window: ListingCandidate[] = []
      let evicted = false
      dir = await opendir(target)
      for (;;) {
        signal.throwIfAborted()
        const dirent = await dir.read()
        if (dirent === null) break
        // Sockets and fifos have no explorer action; files, directories, and
        // symlink probes do.
        if (!dirent.isDirectory() && !dirent.isSymbolicLink() && !dirent.isFile()) continue
        if (placeListingCandidate(window, {
          name: dirent.name,
          direntKind: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'other',
        })) evicted = true
      }
      await dir.close()
      closed = true
      const entries: FileListingEntry[] = []
      for (const candidate of window) {
        signal.throwIfAborted()
        const row = await listingRow(target, candidate.name, candidate.direntKind)
        if (row !== null) entries.push(row)
      }
      return { path: target, entries, truncated: evicted }
    } catch (error: unknown) {
      if (error instanceof TypertRemoteFailure) throw error
      if (signal.aborted) {
        throw new TypertRemoteFailure({ code: 'cancelled', message: 'directory listing was aborted', details: {} })
      }
      throw new TypertRemoteFailure({
        code: 'directory-unreadable',
        message: `cannot list "${target}": ${fsMessage(error)}`,
        details: { path: target },
      })
    } finally {
      // Normal releases are awaited in-place above; only a departed caller
      // drops its handle fire-and-forget here, so an abort never waits behind
      // the very stalled read it escaped (settlement has no consumer left).
      if (!closed && dir !== undefined) void dir.close().catch(() => undefined)
    }
  }
}

/** One streamed listing candidate: the dirent facts an explorer row needs. */
type ListingCandidate = { name: string; direntKind: 'directory' | 'symlink' | 'other' }

/**
 * Insert a streamed candidate into the name-ascending bounded window,
 * keeping the name-sorted head and reporting whether anything beyond the
 * bound was cut. Memory stays O(bound) for arbitrarily large levels, and
 * the reject-at-tail comparison makes a far-over-bound level cost O(1)
 * per extra child (the browse listing's shape).
 */
function placeListingCandidate(window: ListingCandidate[], candidate: ListingCandidate): boolean {
  if (window.length === LIST_FILES_MAX_ENTRIES) {
    /* v8 ignore next -- bounds-established element: the window is exactly full here */
    const tail = window[LIST_FILES_MAX_ENTRIES - 1]
    /* v8 ignore next -- same bounds: tail is always a placed candidate */
    if (tail !== undefined && candidate.name.localeCompare(tail.name) >= 0) return true
  }
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    /* v8 ignore next -- bounds-established element: mid lies within [0, hi) */
    const pivot = window[mid]
    /* v8 ignore next -- same bounds */
    if (pivot !== undefined && candidate.name.localeCompare(pivot.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length > LIST_FILES_MAX_ENTRIES) {
    window.pop()
    return true
  }
  return false
}

/**
 * One file-explorer row for a dirent; symlinks stat-probe their target so
 * the row's kind matches what the client can actually enter or open. A
 * broken or cyclic link is skipped silently — no explorer action can act
 * on it (the browse listing's broken-link policy).
 */
async function listingRow(
  parent: string, name: string, direntKind: 'directory' | 'symlink' | 'other',
): Promise<FileListingEntry | null> {
  const path = join(parent, name)
  let kind: FileListingEntry['kind'] = 'file'
  if (direntKind === 'directory') kind = 'directory'
  else if (direntKind === 'symlink') {
    try {
      kind = (await stat(path)).isDirectory() ? 'directory' : 'file'
    } catch {
      return null
    }
  }
  // POSIX hidden convention (dirents carry no hidden attribute on Windows;
  // the same limitation the browse listing records). The client owns whether
  // hidden rows render.
  return { name, path, kind, hidden: name.startsWith('.') }
}

/** Message text of an unknown thrown value (filesystem rejections may be anything). */
function fsMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
