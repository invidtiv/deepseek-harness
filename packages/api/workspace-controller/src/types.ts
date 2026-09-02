/**
 * Browser-safe request, result, and state-stream vocabulary for the Workspace
 * and directory-picking Remote namespaces this package owns. The picking seam
 * declares its own listing types, so they are re-exported here rather than
 * restated: a browser consumer reads the very declaration the backend answers.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
export type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/** One durable Workspace projected for browser consumers. */
export interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  /** Canonical host directory path. */
  readonly path: string
  /** User-visible title. */
  readonly title: string
  /** Sessions accounted to this Workspace in manual order. */
  readonly sessionIds: readonly SessionId[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested directory cannot back a Workspace. */
    'workspace/invalid-path': { readonly path: string }
    /** Another Workspace already uses the requested name. */
    'workspace/name-conflict': { readonly name: string }
    /** The Session or its anchor is not in the Workspace's manual order. */
    'workspace/move-invalid': {
      readonly workspaceId: WorkspaceId
      readonly sessionId: SessionId
      readonly beforeSessionId?: SessionId
    }
    /** The file-viewer read target was not found. */
    'file-not-found': { readonly path: string }
    /** The file-viewer read target is a directory or failed to read. */
    'file-unreadable': { readonly path: string }
    /** The file-explorer listing target is missing, unreadable, or not a directory. */
    'directory-unreadable': { readonly path: string }
    /** The file verb was cancelled by the caller's departure. */
    'cancelled': { readonly path?: string }
    /** The verb needs an interaction the composed backend does not serve. */
    'directory-picker/unavailable': { readonly capability: string }
    /** The target is not fully qualified, or the backend cannot list it. */
    'directory-picker/unreadable': { readonly path: string }
    /** A child of that name is already there. */
    'directory-picker/exists': { readonly path: string }
    /** The parent is not fully qualified, the name is not one segment, or creation failed. */
    'directory-picker/create-failed': { readonly path: string }
  }
}

/** Existing directory requested for Workspace adoption. */
export interface WorkspaceCreateRequest {
  readonly path: string
}

/** Created or previously registered Workspace. */
export interface WorkspaceCreateValue {
  readonly workspace: WorkspaceView
  readonly created: boolean
}

/** Workspace title mutation. */
export interface WorkspaceRenameRequest {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/** Workspace mutation returning the complete changed row. */
export interface WorkspaceValue {
  readonly workspace: WorkspaceView
}

/** Workspace registration deletion. */
export interface WorkspaceDeleteRequest {
  readonly workspaceId: WorkspaceId
}

/** Receipt after one Workspace registration is deleted. */
export interface WorkspaceDeleteValue {
  readonly deleted: true
}

/** DOM-insertBefore-like Workspace order mutation. */
export interface WorkspaceInsertBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly beforeWorkspaceId?: WorkspaceId
}

/** Complete Workspace registry order after a mutation. */
export interface WorkspaceOrderValue {
  readonly workspaceIds: readonly WorkspaceId[]
}

/** DOM-insertBefore-like Session membership order mutation. */
export interface WorkspaceInsertSessionBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly beforeSessionId?: SessionId
}

/** Session requested for archival from Workspace grouping surfaces. */
export interface WorkspaceArchiveSessionRequest {
  readonly sessionId: SessionId
}

/** Complete archived Session set after a mutation. */
export interface WorkspaceArchiveValue {
  readonly archivedSessionIds: readonly SessionId[]
}

/** Complete reconnect baseline for Workspace browser state. */
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[]
  readonly archivedSessionIds: readonly SessionId[]
}

/** One ordered Workspace change after a generation's baseline. */
export type WorkspaceFollowIncrement =
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }

/** Workspace state stream; every generation starts with exactly one baseline. */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement

/** One text file's contents as the file viewer renders them, with the truncation and binary display flags that bound it. */
export interface FileContents {
  /** The absolute path read (echoed back to the client). */
  readonly path: string
  /** Decoded UTF-8 text; empty when `binary` is true. */
  readonly content: string
  /** Byte length of the file on disk. */
  readonly size: number
  /** True when the file exceeded the read bound and `content` is a truncated prefix. */
  readonly truncated: boolean
  /** True when the file is not valid UTF-8 text (content is empty). */
  readonly binary: boolean
}

/** Workspace file read request. */
export interface FileReadRequest {
  /** Absolute file path to read. */
  readonly path: string
}

/**
 * One row of a {@link FileListing}: a child directory or file of the listed
 * level. Kind follows the filesystem dirent (a symlink resolves to its
 * target's kind), so a client can render enterable rows without probing.
 */
export interface FileListingEntry {
  /** Base name shown in an explorer row. */
  readonly name: string
  /** Absolute host path — the client never joins path segments itself. */
  readonly path: string
  /** `'directory'` rows may be listed again; `'file'` rows are readable via `readFile`. */
  readonly kind: 'directory' | 'file'
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  readonly hidden: boolean
}

/** Workspace file listing response value: one mixed directory level for the file explorer. */
export interface FileListing {
  /** Absolute path of the listed directory (echoed back to the client). */
  readonly path: string
  /** Children of the listed level, name-sorted; symlinks resolved to their target's kind. */
  readonly entries: readonly FileListingEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  readonly truncated: boolean
}

/** Workspace file listing request. */
export interface FileListRequest {
  /** Absolute directory to list; absent lists the Host's default project root. */
  readonly path?: string
}
