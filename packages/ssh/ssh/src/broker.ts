/**
 * Lazy connection owner over the deployment's named SSH environments.
 *
 * The broker composes one {@link SshConnection} per environment on first use
 * and reuses it until the broker unloads. Every connection keeps its own `ssh`
 * service realm, so several worlds coexist in one process exactly as the
 * shipped multi-world composition does, and the connection registers itself
 * with the composed `sshWorlds` pool, which then routes to it by workspace.
 * Each connection fiber is a child of the broker fiber, so unloading the broker
 * tears every connection down with it.
 *
 * The registry supplies both the OpenSSH options and the remote runtime
 * coordinates; the broker contributes only the connection lifetime. It opens
 * no connection for an environment whose runtime coordinates are incomplete.
 * @module @deepseek-ai/dsh-ssh/broker
 */

import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SshConnection, { type Config as SshConnectionConfig } from './index.ts'
import { entriesSchema, infoSchema, targetSchema } from './schemas.ts'
import type { SshWorldConnection } from './worlds.ts'

/**
 * Structural face of the named-environment registry, read by service name so
 * this package keeps no dependency on `dsh-ssh-environments`.
 */
export interface SshEnvironmentRuntimeSource {
  /**
   * List configured environments in declaration order.
   * @returns one summary per configured environment.
   */
  list(): readonly { readonly id: string }[]
  /**
   * Resolve one environment's remote runtime coordinates.
   * @param id - stable environment identity.
   * @returns the coordinates a connection is composed from.
   */
  resolveRuntime(id: string): {
    readonly node: string
    readonly helper: string
    readonly helperHash: string
    readonly workspace: string
    readonly bootstrapPath?: string
    readonly bootstrapHash?: string
  }
}

/** One remote directory level, in the vocabulary a directory-picking surface needs. */
export interface SshRemoteDirectory {
  /** Canonical absolute POSIX path of the listed directory. */
  readonly path: string
  /** The connection's configured remote default workspace. */
  readonly home: string
  /** Ancestor chain from the remote root to {@link path} inclusive. */
  readonly crumbs: readonly { readonly name: string; readonly path: string }[]
  /** Direct child directories, name-sorted. */
  readonly entries: readonly { readonly name: string; readonly path: string }[]
}

/** File-effect policy one remote directory creation runs under. */
export interface SshRemoteDirectoryPolicy {
  /** Effective sandbox mode on the remote host. */
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Absolute remote root the mode is resolved against. */
  readonly workspaceRoot: string
}

/** Test seams; production defaults compose the real connection. */
export interface SshBrokerInternals {
  /**
   * Plugin composed once per environment. Unit specs replace it with a fake
   * that registers `ssh`, because composing the real {@link SshConnection}
   * spawns an `ssh` master no unit host can serve.
   */
  connectionPlugin: Plugin
}

/** Injectable composition seam read at call time, so a spec can replace it. */
export const internals: SshBrokerInternals = { connectionPlugin: SshConnection }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Lazy per-environment SSH connection owner. */
    sshBroker: SshBroker
  }
}

/**
 * Compose one connection in its own `ssh` realm. A failed startup leaves a
 * failed fiber behind, so that fiber is disposed before the error escapes and
 * a later attempt starts clean.
 * @param ctx - Host context the realm extends.
 * @param id - environment identity naming the realm.
 * @param config - validated connection config.
 * @returns the live connection providers route to.
 */
async function composeConnection(ctx: Context, id: string, config: SshConnectionConfig): Promise<SshWorldConnection> {
  const realm = ctx.isolate('ssh', Symbol.for(`dsh-ssh-world:${id}`))
  const fiber = realm.plugin(internals.connectionPlugin, config)
  try {
    await fiber
  } catch (error) {
    await fiber.dispose()
    throw error
  }
  return realm.get('ssh') as SshWorldConnection
}

/** Ancestor chain from a remote root to `target` inclusive, in POSIX spelling. */
function ancestry(target: string): readonly { name: string; path: string }[] {
  const crumbs: { name: string; path: string }[] = []
  let current = target
  for (;;) {
    const parent = posix.dirname(current)
    crumbs.unshift({ name: parent === current ? current : posix.basename(current), path: current })
    if (parent === current) return crumbs
    current = parent
  }
}

/** Opens one connection per configured environment on first use and releases them together. */
export class SshBroker extends Service {
  static inject = ['sshEnvironments']

  private readonly composed = new Map<string, Promise<SshWorldConnection>>()
  /**
   * The broker's own context. `this.ctx` is the CALLER's context while a
   * method runs (the service tracker rebinds it), so composing a child fiber
   * through it would parent that fiber to whichever caller connected first.
   */
  private readonly owner: Context
  private disposed = false

  /** @param ctx - Host context carrying the named-environment registry. */
  constructor(ctx: Context) {
    super(ctx, 'sshBroker')
    this.owner = ctx
    ctx.effect(() => () => this.disposeConnections(), 'ssh-broker: connections')
  }

  /**
   * Environment ids this deployment can connect to: the configured entries
   * that declare every remote runtime coordinate a connection needs.
   * @returns the connectable environment ids, in declaration order.
   */
  list(): readonly string[] {
    const registry = this.registry()
    const ids: string[] = []
    for (const environment of registry.list()) {
      try {
        registry.resolveRuntime(environment.id)
        ids.push(environment.id)
      } catch {
        // An environment with incomplete runtime coordinates cannot connect,
        // so it is not offered; the registry's own error names the fields at
        // connect time.
      }
    }
    return ids
  }

  /**
   * Connect to one environment, composing the connection on first use.
   * Concurrent callers share one attempt.
   * @param id - stable environment identity.
   * @returns the live connection providers route to.
   * @throws {SshEnvironmentUnknownError} when the id is not configured.
   * @throws {SshEnvironmentIncompleteError} when its runtime coordinates are incomplete.
   */
  connect(id: string): Promise<SshWorldConnection> {
    if (this.disposed) return Promise.reject(new Error('ssh-broker: the broker is disposed'))
    const existing = this.composed.get(id)
    if (existing !== undefined) return existing
    const attempt = this.compose(id).catch((error: unknown) => {
      this.composed.delete(id)
      throw error
    })
    this.composed.set(id, attempt)
    return attempt
  }

  /**
   * List one directory level in a named environment, composing its connection
   * on first use. The remote host's own POSIX spelling is preserved, so a
   * caller on any host platform sees canonical remote paths.
   * @param id - stable environment identity.
   * @param path - absolute remote directory; absent lists the environment's workspace.
   * @param signal - caller lifetime, which stops the remote scan.
   * @returns the listed level with its ancestry and the environment's workspace.
   */
  async listDirectory(id: string, path?: string, signal?: AbortSignal): Promise<SshRemoteDirectory> {
    const connection = await this.connect(id)
    const home = this.registry().resolveRuntime(id).workspace
    const requested = path ?? home
    const target = await connection.request('fs.resolve', { path: requested }, targetSchema, signal)
    const info = await connection.request('fs.stat', { target }, infoSchema.nullable(), signal)
    if (info === null || info.type !== 'directory') throw new Error(`${JSON.stringify(requested)} is not a remote directory`)
    const directory = target.targetKey
    const listed = await connection.request('fs.list', { target }, entriesSchema, signal)
    const entries = listed
      .filter(entry => entry.type === 'directory')
      .map(entry => ({ name: entry.name, path: entry.target.displayPath }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { path: directory, home, crumbs: ancestry(directory), entries }
  }

  /**
   * Create one child directory in a named environment.
   * @param id - stable environment identity.
   * @param path - absolute remote parent that already exists.
   * @param name - single child segment.
   * @param policy - file-effect policy the creation runs under.
   * @param signal - caller lifetime.
   * @returns the created directory's canonical absolute remote path.
   */
  async createDirectory(id: string, path: string, name: string, policy: SshRemoteDirectoryPolicy, signal?: AbortSignal): Promise<string> {
    const connection = await this.connect(id)
    const parent = await connection.request('fs.resolve', { path }, targetSchema, signal)
    const child = await connection.request('fs.resolve', { path: name, cwd: parent.targetKey }, targetSchema, signal)
    await connection.request('fs.mkdir', { target: child, policy }, z.null(), signal)
    return child.targetKey
  }

  /** Resolve one environment's config and compose its connection. */
  private async compose(id: string): Promise<SshWorldConnection> {
    return await composeConnection(this.owner, id, this.connectionConfig(id))
  }

  /** The connection config one environment's runtime coordinates resolve to. */
  private connectionConfig(id: string): SshConnectionConfig {
    const runtime = this.registry().resolveRuntime(id)
    return {
      environment: id,
      node: runtime.node,
      helper: runtime.helper,
      helperHash: runtime.helperHash,
      workspace: runtime.workspace,
      ...(runtime.bootstrapPath === undefined ? {} : { bootstrapPath: runtime.bootstrapPath, bootstrapHash: runtime.bootstrapHash }),
    }
  }

  private async disposeConnections(): Promise<void> {
    this.disposed = true
    // Every connection fiber is a child of this fiber and is disposed with it;
    // awaiting the in-flight compositions joins that teardown instead of
    // returning before a connection's remote cleanup settled.
    await Promise.allSettled([...this.composed.values()])
    this.composed.clear()
  }

  private registry(): SshEnvironmentRuntimeSource {
    // The declared injection guarantees the registry is active here.
    return this.owner.get('sshEnvironments') as SshEnvironmentRuntimeSource
  }
}

export default SshBroker
