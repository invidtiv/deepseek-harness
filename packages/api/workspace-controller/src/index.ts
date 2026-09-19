/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { reachableEnvironmentIds } from './environments.ts'
import { WorkspaceFileBrowse } from './file-browse.ts'
import { WorkspaceFeed } from './feed.ts'
import type {
  FileContents,
  FileListRequest,
  FileListing,
  FileReadRequest,
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceEnvironmentView,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'
export { WorkspaceFileBrowse } from './file-browse.ts'
export type { WorkspaceFileBrowseConfig } from './file-browse.ts'

/** Structural view of the SSH environment registry the picker reads by service name. */
interface SshEnvironmentLister {
  list(): readonly { id: string; label: string; host: string; port?: number }[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'fs']

  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed
  private readonly browse: WorkspaceFileBrowse

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(ctx: Context) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    this.browse = new WorkspaceFileBrowse(ctx.fs)
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * List the deployment's named SSH environments for the workspace picker.
   * @returns each configured environment, or an empty list when no registry is composed.
   */
  @Remote('environments')
  environments(): WorkspaceEnvironmentView[] {
    const registry = this.ctx.get('sshEnvironments') as SshEnvironmentLister | undefined
    const reachable = reachableEnvironmentIds(this.ctx)
    return registry?.list().map(environment => ({
      environmentId: environment.id,
      label: environment.label,
      host: environment.host,
      ...(environment.port === undefined ? {} : { port: environment.port }),
      reachable: reachable.has(environment.id),
    })) ?? []
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Restore one archived Session to Workspace grouping surfaces.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  @Remote('unarchiveSession')
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.unarchiveSession(request)
  }

  /**
   * Read one text file's contents for the file viewer, bounded and
   * binary-refusing: a missing path, a directory, and a read failure each
   * become their own wire failure, a file too large to show whole returns a
   * truncated prefix, and a non-text file returns `binary` with empty
   * content.
   * @param request - the read request.
   * @param signal - caller/connection lifetime.
   * @returns the file contents.
   */
  @Remote('readFile')
  readFile(request: FileReadRequest, signal: AbortSignal): Promise<FileContents> {
    return this.browse.readFile(request, signal)
  }

  /**
   * List one mixed directory level (child directories and files) for the
   * file explorer, bounded: the composed filesystem resolves symlinks, and
   * the answer keeps the name-sorted head plus the `truncated` flag. An
   * unreadable or missing level — including a non-directory target — fails
   * with the shared listing code.
   * @param request - the listing request; an absent path lists the
   *   configured default project root.
   * @param signal - caller/connection lifetime.
   * @returns the mixed listing.
   */
  @Remote('listFiles')
  listFiles(request: FileListRequest, signal: AbortSignal): Promise<FileListing> {
    return this.browse.listFiles(request, signal)
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.follow(signal)
  }
}

export default WorkspaceController
