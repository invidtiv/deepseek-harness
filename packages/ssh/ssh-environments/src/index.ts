/**
 * Settings-backed registry of named POSIX SSH environments. Each environment
 * carries the OpenSSH connection options one deployment of the SSH provider
 * family needs, keyed by a stable id that survives reconnection and Session
 * restarts. The registry stores configuration only: it owns no connection,
 * interprets no remote path, and contributes no model-visible content.
 * @module @deepseek-ai/dsh-ssh-environments
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { resolveSshEnvironment, type SshEnvironment } from '@deepseek-ai/dsh-ssh'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'

/** Settings namespace this registry owns. */
export const SSH_ENVIRONMENTS_NAMESPACE = 'ssh-environments'

/**
 * Stable identity of one named SSH environment. A generated or
 * deployment-chosen slug, never `host`+`path`: the identity must survive a
 * reconnection, an address change, and a rename of the remote directory.
 */
export type SshEnvironmentId = Branded<'SshEnvironmentId'>

/** Connection options plus the display label of one named SSH environment. */
export interface SshEnvironmentEntry extends SshEnvironment {
  /** Display label for host pickers; absent falls back to the environment id. */
  label?: string
}

/** The registry's user-editable settings value, keyed by environment id. */
export interface SshEnvironmentsSettings {
  /** Configured environments in declaration order. */
  environments: Record<string, SshEnvironmentEntry>
}

/** Client-safe projection of one environment for host and directory pickers. */
export interface SshEnvironmentSummary {
  /** Stable environment identity. */
  readonly id: SshEnvironmentId
  /** Display label; the id when the entry declares none. */
  readonly label: string
  /** OpenSSH destination. */
  readonly host: string
  /** Explicit TCP port, when the entry declares one. */
  readonly port?: number
}

/**
 * The user-writable schema. It mirrors the connection fields
 * {@link resolveSshEnvironment} validates, plus the optional display label, and
 * declares no secret slot: an entry stores a key path, an agent socket, or a
 * config file path, never key material or a passphrase.
 */
export const SshEnvironmentsSchema: z<SshEnvironmentsSettings> = z.object({
  environments: z.dict(z.object({
    label: z.string(),
    host: z.string().required(),
    port: z.number().min(1).max(65_535),
    user: z.string(),
    identityFile: z.string(),
    identityAgent: z.string(),
    proxyJump: z.string(),
    configFile: z.string(),
    hostKeyChecking: z.union(['yes', 'accept-new', 'no'] as const),
    connectTimeoutMs: z.number().min(1).max(2_147_483_647),
    serverAliveIntervalMs: z.number().min(1).max(2_147_483_647),
    serverAliveCountMax: z.number().min(0).max(2_147_483_647),
  })).default({}),
})

/** Lookup failed because no configured environment carries the id. */
export class SshEnvironmentUnknownError extends Error {
  /** The id that resolved to no environment. */
  readonly id: SshEnvironmentId

  /** @param id - the missing environment identity. */
  constructor(id: SshEnvironmentId) {
    super(`SSH environment "${id}" is not configured`)
    this.name = 'SshEnvironmentUnknownError'
    this.id = id
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshEnvironments: SshEnvironments
  }
}

/**
 * Registry over the deployment's named SSH environments.
 *
 * The service registers the {@link SSH_ENVIRONMENTS_NAMESPACE} settings
 * namespace during activation and resolves a stable id into validated OpenSSH
 * connection options. It never opens a connection and never stores a secret;
 * the SSH provider family owns both.
 */
export default class SshEnvironments extends Service {
  private scope: SettingsScope<SshEnvironmentsSettings> | undefined

  /** @param ctx - the Cordis context this service registers on. */
  constructor(ctx: Context) {
    super(ctx, 'sshEnvironments')
    ctx.inject(['settings'], (settingsCtx) => {
      this.scope = settingsCtx.settings.register(SSH_ENVIRONMENTS_NAMESPACE, SshEnvironmentsSchema)
      settingsCtx.effect(() => () => { this.scope = undefined }, 'sshEnvironments.settings()')
    })
  }

  /**
   * List configured environments in declaration order.
   * @returns one client-safe summary per environment.
   */
  list(): readonly SshEnvironmentSummary[] {
    const environments = this.requireScope().get().environments
    return Object.entries(environments).map(([id, entry]) => ({
      id: id as SshEnvironmentId,
      label: entry.label ?? id,
      host: entry.host,
      ...(entry.port === undefined ? {} : { port: entry.port }),
    }))
  }

  /**
   * Read one environment's stored entry.
   * @param id - stable environment identity.
   * @returns the entry, or `undefined` when the id is not configured.
   */
  get(id: SshEnvironmentId): SshEnvironmentEntry | undefined {
    return this.requireScope().get().environments[id]
  }

  /**
   * Resolve one environment into validated OpenSSH connection options with this
   * provider's defaults applied.
   * @param id - stable environment identity.
   * @returns the resolved connection options.
   * @throws {SshEnvironmentUnknownError} when the id is not configured.
   */
  resolve(id: SshEnvironmentId): SshEnvironment {
    const entry = this.get(id)
    if (entry === undefined) throw new SshEnvironmentUnknownError(id)
    const { label: _label, ...connection } = entry
    return resolveSshEnvironment(connection)
  }

  /** Read the registered namespace, failing loud when no settings provider is composed. */
  private requireScope(): SettingsScope<SshEnvironmentsSettings> {
    if (this.scope === undefined) {
      throw new Error('sshEnvironments requires a composed settings provider to read its environments')
    }
    return this.scope
  }
}
