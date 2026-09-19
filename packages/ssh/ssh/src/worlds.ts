/**
 * One connection per SSH environment, and the routing that selects between them.
 *
 * A deployment composes one `SshConnection` row per environment and one
 * `SshWorlds` row; every connection registers itself here while the pool is
 * composed. Providers ask the pool which connection a target belongs to, so the
 * filesystem, subprocess and sandbox seams stay free of a session argument: the
 * workspace registry's locator — environment plus remote directory — decides.
 * A target no locator claims belongs to the deployment's default connection,
 * and a target whose world has no composed connection fails visibly.
 */

import type { Socket } from 'node:net'
import { Service, type Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { z } from 'zod'
import type { SshStreamEndpoint } from './schemas.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One connection per SSH environment and the routing between them. */
    sshWorlds: SshWorlds
  }
}

/** The connection face the pool hands to providers. */
export interface SshWorldConnection {
  /**
   * Send one helper operation on this connection.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait?: boolean): Promise<T>
  /**
   * Forward one authenticated stream through an independent channel on this connection.
   * @param endpoint - private coordinates issued by this connection's helper.
   * @param signal - cancellation of allocation and the resulting socket.
   * @returns a paused socket; attach a consumer before resuming it.
   */
  connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>
  /** Release this connection and its remote cleanup. */
  dispose(): Promise<void>
}

/** One remote directory a composed connection owns. */
export interface SshWorldLocator {
  /** World identity; absent for a directory the default connection serves. */
  readonly environmentId?: string
  /** Canonical remote directory this locator owns. */
  readonly path: string
}

/**
 * Structural face of the workspace registry the pool reads locators from. Read
 * by service name so this package depends on no workspace package.
 */
export interface SshWorldLocatorSource {
  /**
   * List every registered workspace.
   * @returns the durable workspace rows, in registry order.
   */
  list(): readonly {
    readonly transport: 'local' | 'ssh'
    readonly environmentId?: string
    readonly path: string
  }[]
}

/**
 * Raised when an operation that carries no target runs while the deployment
 * composes named worlds, so it cannot select one.
 */
export class SshWorldMultipleError extends Error {
  override readonly name = 'SshWorldMultipleError'

  /**
   * @param operation - the provider operation that needs one world.
   * @param environmentIds - the composed named worlds, in registration order.
   */
  constructor(readonly operation: string, readonly environmentIds: readonly string[]) {
    super(`ssh: ${operation} needs one world, but this deployment composes ${environmentIds.join(', ')}`)
  }
}

/** Raised when a target names a world no composed connection serves. */
export class SshWorldUnavailableError extends Error {
  override readonly name = 'SshWorldUnavailableError'

  /** @param environmentId - the world the target named, or the empty string for the default world. */
  constructor(readonly environmentId: string) {
    super(environmentId === ''
      ? 'ssh: no default world connection is composed'
      : `ssh: no connection is composed for environment "${environmentId}"`)
  }
}

/**
 * Raised when two worlds claim one remote directory, so a target cannot select
 * between them. Distinct directories per environment keep routing unambiguous.
 */
export class SshWorldAmbiguousError extends Error {
  override readonly name = 'SshWorldAmbiguousError'

  /**
   * @param path - the remote directory both worlds claim.
   * @param environmentIds - the claiming environment ids, in registry order.
   */
  constructor(readonly path: string, readonly environmentIds: readonly string[]) {
    super(`ssh: "${path}" is claimed by ${environmentIds.join(' and ')}; give each world a distinct directory`)
  }
}

/** Pool configuration: which composed world serves a target no locator claims. */
export interface Config {
  /**
   * Environment id of the default world. The deployment names the same id on
   * the `ssh` row that is not isolated; a registration under the empty key
   * (an inline destination) always wins for unclaimed targets.
   */
  defaultEnvironment?: string
}

/** Routes each remote operation to the connection that owns its target's world. */
export class SshWorlds extends Service {
  static Config: schema<Config> = schema.object({ defaultEnvironment: schema.string() })

  private readonly connections = new Map<string | undefined, SshWorldConnection>()

  /**
   * @param ctx - the host context this pool registers on.
   * @param config - the world that serves targets no locator claims.
   */
  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'sshWorlds')
  }

  /**
   * Register one composed connection for the world it serves.
   * @param environmentId - the world's environment id; undefined is the deployment default.
   * @param connection - the connection that owns that world.
   * @returns the disposer removing this registration.
   */
  register(environmentId: string | undefined, connection: SshWorldConnection): () => void {
    if (this.connections.has(environmentId)) {
      throw new Error(`ssh: environment "${environmentId ?? ''}" already has a composed connection`)
    }
    this.connections.set(environmentId, connection)
    return () => { this.connections.delete(environmentId) }
  }

  /**
   * List the worlds with a composed connection.
   * @returns the environment ids in registration order; the default connection contributes none.
   */
  list(): readonly string[] {
    return [...this.connections.keys()].filter((id): id is string => id !== undefined)
  }

  /**
   * Refuse an operation that carries no target while named worlds are composed.
   * @param operation - the provider operation that needs a single world.
   * @throws {SshWorldMultipleError} when more than one named world is composed.
   */
  requireDefaultWorld(operation: string): void {
    const worlds = this.list()
    if (worlds.length > 0) throw new SshWorldMultipleError(operation, worlds)
  }

  /**
   * Resolve the connection one remote path belongs to.
   * @param path - absolute remote path in some composed world.
   * @returns the connection serving that path's world.
   * @throws {SshWorldUnavailableError} when the path's world has no composed connection.
   * @throws {SshWorldAmbiguousError} when two worlds claim the path.
   */
  connectionFor(path: string): SshWorldConnection {
    const environmentId = this.worldFor(path)
    if (environmentId === undefined) return this.defaultConnection()
    const connection = this.connections.get(environmentId)
    if (connection === undefined) throw new SshWorldUnavailableError(environmentId)
    return connection
  }

  /** The connection that serves a target no locator claims. */
  private defaultConnection(): SshWorldConnection {
    const named = this.config.defaultEnvironment
    const connection = this.connections.get(undefined)
      ?? (named === undefined ? undefined : this.connections.get(named))
    if (connection === undefined) throw new SshWorldUnavailableError('')
    return connection
  }

  /**
   * Resolve the world one remote path belongs to: the longest owning locator wins.
   * @param path - absolute remote path in some composed world.
   * @returns the owning environment id, or undefined for the default connection.
   * @throws {SshWorldAmbiguousError} when two worlds claim the same directory.
   */
  worldFor(path: string): string | undefined {
    let owner: SshWorldLocator | undefined
    for (const locator of this.locators()) {
      if (!contains(locator.path, path)) continue
      if (owner === undefined || locator.path.length > owner.path.length) {
        owner = locator
        continue
      }
      if (locator.path.length === owner.path.length && locator.environmentId !== owner.environmentId) {
        throw new SshWorldAmbiguousError(locator.path, [owner.environmentId ?? '', locator.environmentId ?? ''])
      }
    }
    return owner?.environmentId
  }

  /** Every remote directory a registered workspace owns, in registry order. */
  private locators(): readonly SshWorldLocator[] {
    const registry = this.ctx.get('workspaceRegistry') as SshWorldLocatorSource | undefined
    return (registry?.list() ?? [])
      .filter(workspace => workspace.transport === 'ssh')
      .map(workspace => ({
        ...(workspace.environmentId === undefined ? {} : { environmentId: workspace.environmentId }),
        path: workspace.path,
      }))
  }
}

/** Whether one canonical directory contains a path. */
function contains(directory: string, path: string): boolean {
  const root = directory.length > 1 && directory.endsWith('/') ? directory.slice(0, -1) : directory
  return path === root || path.startsWith(root === '/' ? root : `${root}/`)
}

export default SshWorlds
