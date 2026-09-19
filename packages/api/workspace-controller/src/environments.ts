/** Host facts about which composed execution worlds this deployment can reach. */

import type { Context } from '@deepseek-ai/cordis'

/** Structural face of the SSH world pool. */
interface SshWorldPool {
  /**
   * List every world with a composed connection.
   * @returns the environment ids the pool owns, in registration order.
   */
  list(): readonly string[]
}

/** Structural face of the connection a single-world deployment composes. */
interface SshDefaultConnection {
  /** Named environment this connection resolved; absent for an inline destination. */
  readonly environmentId?: string
}

/**
 * Environment ids one deployment can actually reach: every world with a
 * composed connection, whether the pool owns it or the composed connection
 * resolves it by name. An environment outside this set has no connection, so a
 * workspace registered against it would be served by a different world.
 * @param ctx - Host context.
 * @returns the reachable environment ids.
 */
export function reachableEnvironmentIds(ctx: Context): ReadonlySet<string> {
  const pool = ctx.get('sshWorlds') as SshWorldPool | undefined
  const ids = new Set<string>(pool?.list() ?? [])
  const composed = (ctx.get('ssh') as SshDefaultConnection | undefined)?.environmentId
  if (composed !== undefined) ids.add(composed)
  return ids
}
