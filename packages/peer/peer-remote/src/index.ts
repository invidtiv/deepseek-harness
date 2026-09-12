/**
 * Register one peer Harness transport on `ctx.peers`, dialing that peer's
 * Remote API with a browser-session cookie resolved through the credentials
 * plane.
 * @module @deepseek-ai/dsh-peer-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-peer'
import { RemotePeerError, RemotePeerTransport } from './remote.ts'

export { RemotePeerError, RemotePeerTransport } from './remote.ts'
export type { RemotePeerTransportOptions } from './remote.ts'

/** Cordis plugin name. */
export const name = 'peer-remote'

/** Required peer transport registry. */
export const inject = ['peers']

/** Credential reference holding one peer's browser-session cookie. */
export const DEFAULT_COOKIE_ENV = 'DSH_PEER_COOKIE'
/** Bound (ms) on one unary Remote call. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Bound (ms) on waiting for one peer turn to end. */
export const DEFAULT_ASK_TIMEOUT_MS = 180_000
/** Delay (ms) between turns of the peer completion poll. */
export const DEFAULT_POLL_INTERVAL_MS = 2500

/** Configuration for one peer Harness transport. */
export interface Config {
  /** Peer name used by every consumer and by tool arguments. */
  peerId: string
  /** Peer web origin, for example `https://host.tailnet.ts.net:8443`. */
  baseUrl: string
  /** Credential reference holding this peer's browser-session cookie. */
  cookieEnv?: string
  /** Peer working directory used when a request names none. */
  defaultCwd?: string
  /** Peer agent preset used when a request names none. */
  defaultAgentPreset?: string
  /** Bound (ms) on one unary Remote call. */
  requestTimeoutMs?: number
  /** Bound (ms) on waiting for one peer turn to end. */
  askTimeoutMs?: number
  /** Delay (ms) between turns of the peer completion poll. */
  pollIntervalMs?: number
}

/** Schemastery configuration for one peer Harness transport. */
export const Config: z<Config> = z.object({
  peerId: z.string().required(),
  baseUrl: z.string().required(),
  cookieEnv: z.string().role('credential-ref').default(DEFAULT_COOKIE_ENV),
  defaultCwd: z.string(),
  defaultAgentPreset: z.string(),
  requestTimeoutMs: z.number().step(1).min(1).default(DEFAULT_REQUEST_TIMEOUT_MS),
  askTimeoutMs: z.number().step(1).min(1).default(DEFAULT_ASK_TIMEOUT_MS),
  pollIntervalMs: z.number().step(1).min(1).default(DEFAULT_POLL_INTERVAL_MS),
})

type ResolvedConfig =
  & Required<Omit<Config, 'defaultCwd' | 'defaultAgentPreset'>>
  & Pick<Config, 'defaultCwd' | 'defaultAgentPreset'>

/**
 * Resolve and validate one peer web origin.
 * @param baseUrl - configured peer origin.
 * @returns the origin without a trailing slash.
 */
function resolveBaseUrl(baseUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`peer-remote baseUrl is not an absolute URL: ${JSON.stringify(baseUrl)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`peer-remote baseUrl must be http or https, got ${parsed.protocol}`)
  }
  return parsed.origin
}

/** Register one peer Harness transport with `ctx.peers`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const baseUrl = resolveBaseUrl(resolved.baseUrl)
  const cookieRef = credentialRef(resolved.cookieEnv)
  const transport = new RemotePeerTransport({
    peerId: resolved.peerId,
    baseUrl,
    resolveCookie: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const resolvedCredential = (await credentials.resolve(cookieRef))?.value
        if (resolvedCredential !== undefined && resolvedCredential.length > 0) return resolvedCredential
      }
      // Without the credentials seam the launch environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(cookieRef)
      if (ambient !== undefined && ambient.value.length > 0) return ambient.value
      throw new RemotePeerError(
        `peer "${resolved.peerId}" has no credential for "${resolved.cookieEnv}"; store the browser-session cookie there`,
      )
    },
    defaultCwd: resolved.defaultCwd,
    defaultAgentPreset: resolved.defaultAgentPreset,
    requestTimeoutMs: resolved.requestTimeoutMs,
    askTimeoutMs: resolved.askTimeoutMs,
    pollIntervalMs: resolved.pollIntervalMs,
  })
  ctx.effect(() => ctx.peers.register(transport))
}
