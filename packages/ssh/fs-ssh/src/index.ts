/** Filesystem provider preserving remote identities and helper-owned atomic mutations. */
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { SshWorldUnavailableError, type SshWorldConnection } from '@deepseek-ai/dsh-ssh'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { editResultSchema, entriesSchema, infoSchema, pathInfoSchema, targetSchema, textStreamIdSchema, writeResultSchema } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'

const errorCodes: Record<FsErrorCode, true> = {
  FS_NOT_FOUND: true, FS_NOT_DIRECTORY: true, FS_NOT_TEXT: true, FS_NOT_REGULAR_FILE: true,
  FS_TOO_LARGE: true, FS_PERMISSION_DENIED: true, FS_SANDBOX_DENIED: true, FS_IO_ERROR: true,
  FS_STALE_VERSION: true, FS_NOT_OBSERVED: true, FS_ALREADY_EXISTS: true, FS_AMBIGUOUS_EDIT: true,
  FS_EDIT_NOT_FOUND: true, FS_ABORTED: true,
}

/**
 * Separator between a target's world identity and its remote path in the
 * HOST-side target key. It never reaches the wire: the helper sees the
 * stripped target, so its strict path schema stays unchanged.
 */
const WORLD_SEPARATOR = '\u0000'

/** Structural face of the composed world pool this provider routes through. */
interface SshWorldsPool {
  connectionFor(path: string): SshWorldConnection
  connectionForEnvironment(environmentId: string): SshWorldConnection
  worldFor(path: string): string | undefined
}

/** Split a host-side target key into its named world and remote path. */
function splitWorld(key: string): { environmentId?: string; path: string } {
  const separator = key.indexOf(WORLD_SEPARATOR)
  if (separator === -1) return { path: key }
  return { environmentId: key.slice(0, separator), path: key.slice(separator + 1) }
}

/** Encode one remote target with the world it was resolved in. */
function worldTarget(environmentId: string | undefined, target: { targetKey: string; displayPath: string }): FsTarget {
  return {
    targetKey: FsTargetKey(environmentId === undefined
      ? target.targetKey
      : `${environmentId}${WORLD_SEPARATOR}${target.targetKey}`),
    displayPath: target.displayPath,
  }
}

/** The absolute path a request addresses, before any provider resolves it. */
function effectivePath(path: string, cwd: string | undefined): string {
  if (posix.isAbsolute(path)) return path
  return cwd === undefined ? path : posix.join(cwd, path)
}

/**
 * Remote filesystem paired with the SSH subprocess and sandbox providers.
 *
 * Every target records the world it was resolved in, and each operation routes
 * by that record — falling back to the workspace-locator routing when the
 * target carries none. When the deployment composes a `localFs` delegate (the
 * local execution world of a mixed deployment), a path no SSH world claims is
 * served by that delegate instead, so one process serves local and remote
 * workspaces together.
 */
export class SshFileSystem extends FileSystem {
  // The connection is read by service name rather than injected: a mixed
  // deployment composes its connections inside the world pool and has no
  // single root `ssh` service, while a single-world deployment still does.
  static inject = ['sandboxPolicy']

  override get sandboxMode(): SandboxMode { return this.ctx.sandboxPolicy.defaultMode }

  /** Targets in the local world are host entries, so a native chooser can address them. */
  override get addressesHostFilesystem(): boolean { return this.local() !== undefined }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal; environmentId?: string }): Promise<FsTarget> {
    const environmentId = opts?.environmentId
    if (environmentId !== undefined) {
      const connection = this.connectionForEnvironment(environmentId)
      const target = await this.callOn(connection, 'fs.resolve', { path, cwd: opts?.cwd }, targetSchema, opts?.signal)
      return worldTarget(environmentId, target)
    }
    const owner = this.worlds()?.worldFor(effectivePath(path, opts?.cwd))
    const local = this.local()
    if (owner === undefined && local !== undefined) return await local.resolve(path, opts)
    const target = await this.call(effectivePath(path, opts?.cwd), 'fs.resolve', { path, cwd: opts?.cwd }, targetSchema, opts?.signal)
    return worldTarget(owner, target)
  }

  override processPath(target: FsTarget): string { return splitWorld(String(target.targetKey)).path }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return this.local()?.processPathFromHostPath(hostPath)
  }

  override fileUrl(target: FsTarget): string {
    const local = this.localFor(target)
    if (local !== undefined) return local.fileUrl(target)
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const local = this.localFor(parent)
    if (local !== undefined && this.localFor(child) === local) return local.contains(parent, child)
    const path = posix.relative(this.processPath(parent), this.processPath(child))
    return path === '' || (!path.startsWith('../') && path !== '..' && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.stat(target, signal)
    return await this.callOnTarget(target, 'fs.stat', { target: this.wire(target) }, infoSchema.nullable(), signal) as FsInfo | null ?? undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const requested = effectivePath(path, opts?.cwd)
    const local = this.local()
    if (this.worlds()?.worldFor(requested) === undefined && local !== undefined) return await local.lstat(path, opts, signal)
    return await this.call(requested, 'fs.lstat', { path, cwd: opts?.cwd }, pathInfoSchema.nullable(), signal) as FsPathInfo | null ?? undefined
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.readText(target, signal)
    return await this.callOnTarget(target, 'fs.readText', { target: this.wire(target) }, z.string(), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.streamText(target, signal)
    // One stream id belongs to the connection that opened it, so every
    // continuation stays on that same world.
    const connection = this.targetConnection(target)
    const id = await this.callOn(connection, 'fs.stream', { target: this.wire(target) }, textStreamIdSchema, signal)
    const call = <T>(method: string, params: unknown, schema: z.ZodType<T>, at?: AbortSignal): Promise<T> =>
      this.callOn(connection, method, params, schema, at)
    return (async function* () {
      let ended = false
      try {
        while (!ended) {
          signal?.throwIfAborted()
          const next = await call('fs.next', { id }, z.object({ done: z.boolean(), value: z.string() }).strict(), signal)
          ended = next.done
          if (next.value.length > 0) yield next.value
        }
      } finally {
        if (!ended) await call('fs.streamClose', { id }, z.null()).catch(() => {})
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.readBytes(target, signal, maxBytes)
    return Buffer.from(await this.callOnTarget(target, 'fs.readBytes', { target: this.wire(target), maxBytes }, z.base64(), signal), 'base64')
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.readByteRange(target, range, signal)
    return Buffer.from(await this.callOnTarget(target, 'fs.readRange', { target: this.wire(target), ...range }, z.base64(), signal), 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.listDir(target, signal)
    return await this.callOnTarget(target, 'fs.list', { target: this.wire(target) }, entriesSchema, signal) as FsDirEntry[]
  }

  override async mkdir(target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<void> {
    const local = this.localFor(target)
    if (local !== undefined) {
      await local.mkdir(target, signal, sandboxPolicy)
      return
    }
    // Same resolution as the other mutations: an omitted policy is the
    // deployment's, so a remote caller behaves like a local one. The helper
    // still fails closed on a call that carries no policy at all.
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    await this.callOnTarget(target, 'fs.mkdir', { target: this.wire(target), policy }, z.null(), signal)
  }

  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.writeText(target, content, expected, signal, sandboxPolicy)
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    return await this.callOnTarget(target, 'fs.write', { target: this.wire(target), content, expected, policy }, writeResultSchema, signal) as FsWriteOutcome
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const local = this.localFor(target)
    if (local !== undefined) return await local.editText(target, edit, expected, signal, sandboxPolicy)
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    return await this.callOnTarget(target, 'fs.edit', { target: this.wire(target), edit, expected, policy }, editResultSchema, signal) as FsEditOutcome
  }

  /** The composed world pool, or undefined for a single-connection deployment. */
  private worlds(): SshWorldsPool | undefined {
    return this.ctx.get('sshWorlds')
  }

  /** The composed local execution world, or undefined for a remote-only deployment. */
  private local(): FileSystem | undefined {
    return this.ctx.get('localFs') as FileSystem | undefined
  }

  /** The local delegate for a target no SSH world claims, or undefined for a remote target. */
  private localFor(target: FsTarget): FileSystem | undefined {
    const local = this.local()
    if (local === undefined) return undefined
    const { environmentId, path } = splitWorld(String(target.targetKey))
    if (environmentId !== undefined) return undefined
    return this.worlds()?.worldFor(path) === undefined ? local : undefined
  }

  /** The connection that owns one target: its recorded world, else the locator routing. */
  private targetConnection(target: FsTarget): SshWorldConnection {
    const { environmentId, path } = splitWorld(String(target.targetKey))
    if (environmentId !== undefined) return this.connectionForEnvironment(environmentId)
    return this.connectionFor(path)
  }

  /** The connection that owns one remote path: the composed pool's routing, or the deployment's own connection. */
  private connectionFor(path: string): SshWorldConnection {
    const worlds = this.worlds()
    if (worlds !== undefined) return worlds.connectionFor(path)
    // Non-strict: a connection still completing startup is this deployment's
    // own, and its requests await readiness themselves.
    const own = this.ctx.get('ssh', false) as SshWorldConnection | undefined
    if (own === undefined) throw new SshWorldUnavailableError('')
    return own
  }

  /** The connection composed for one named world, refusing an unreachable environment. */
  private connectionForEnvironment(environmentId: string): SshWorldConnection {
    const worlds = this.worlds()
    if (worlds !== undefined) return worlds.connectionForEnvironment(environmentId)
    // A single-connection deployment has no pool: its own connection serves the
    // environment it resolved, and refuses to impersonate any other.
    const own = this.ctx.get('ssh', false) as (SshWorldConnection & { readonly environmentId?: string }) | undefined
    if (own === undefined || (own.environmentId !== undefined && own.environmentId !== environmentId)) {
      throw new SshWorldUnavailableError(environmentId)
    }
    return own
  }

  /** The target exactly as the helper's strict schema expects it. */
  private wire(target: FsTarget): { targetKey: string; displayPath: string } {
    return { targetKey: this.processPath(target), displayPath: target.displayPath }
  }

  private async call<T>(at: string, method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return await this.callOn(this.connectionFor(at), method, params, schema, signal)
  }

  private async callOnTarget<T>(target: FsTarget, method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return await this.callOn(this.targetConnection(target), method, params, schema, signal)
  }

  private async callOn<T>(
    connection: SshWorldConnection, method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal,
  ): Promise<T> {
    try { return await connection.request(method, params, schema, signal) } catch (error) {
      if (error instanceof RemoteOperationError && error.code !== undefined && Object.hasOwn(errorCodes, error.code)) {
        throw new FsError(error.message, error.code as FsErrorCode, { cause: error })
      }
      throw new FsError(error instanceof Error ? error.message : String(error), signal?.aborted ? 'FS_ABORTED' : 'FS_IO_ERROR', { cause: error })
    }
  }
}

export default SshFileSystem
