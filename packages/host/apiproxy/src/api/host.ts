/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/**
 * One row of a {@link FileListing}: a child directory or file of the listed
 * level. Kind follows the filesystem dirent (a symlink resolves to its
 * target's kind), so a client can render enterable rows without probing.
 */
export interface FileListingEntry {
  /** Base name shown in an explorer row. */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** `'directory'` rows may be listed again; `'file'` rows are readable via `readFile`. */
  kind: 'directory' | 'file'
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** host.listFiles response value: one mixed directory level for the file explorer. */
export interface FileListing {
  /** Absolute path of the listed directory (echoed back to the client). */
  path: string
  /** Children of the listed level, name-sorted; symlinks resolved to their target's kind. */
  entries: FileListingEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/**
 * One text file's contents as the file viewer renders them: the decoded
 * UTF-8 text (empty for a binary file), the byte size, and the two flags
 * that bound the display (truncation at the read cap, binary refusal).
 */
export interface FileContents {
  /** The absolute path read (echoed back to the client). */
  path: string
  /** Decoded UTF-8 text; empty when `binary` is true. */
  content: string
  /** Byte length of the file on disk. */
  size: number
  /** True when the file exceeded the read bound and `content` is a truncated prefix. */
  truncated: boolean
  /** True when the file is not valid UTF-8 text (content is empty). */
  binary: boolean
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * home = the host account home directory (Web display abbreviation on POSIX);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    home: string
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. Only served under the `browse` capability;
   * unreadable or missing targets fail with `directory-unreadable`. The
   * carrier's request signal follows the caller, stopping the backend's scan
   * on disconnect or timeout.
   */
  listDirectory(
    request: RpcRequest<{ path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>

  /**
   * Read one text file for the in-app file viewer. Reads are bounded: a file
   * larger than the read cap returns a truncated prefix with `truncated`, and
   * a file that is not valid UTF-8 returns `binary` with empty content rather
   * than garbled text. A missing path fails with `file-not-found`; a
   * directory or an unreadable target fails with `file-unreadable`. Like
   * `openPath`, this is a privileged method gated to loopback callers.
   */
  readFile(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<FileContents>>

  /**
   * List one mixed directory level (child directories and files) for the
   * file explorer. An absent path lists the host process working directory
   * (the project root). Entries are bounded like `listDirectory`: the
   * name-sorted head is returned and `truncated` flags a cut level. An
   * unreadable or missing target fails with `directory-unreadable`. Like
   * `readFile`, this is a privileged method gated to loopback callers — the
   * listing reveals host filesystem structure, which is reconnaissance of
   * the same class as reading file contents.
   */
  listFiles(
    request: RpcRequest<{ path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<FileListing>>
}
