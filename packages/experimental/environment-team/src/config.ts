/** Deployment-owned peer grants, workspace mappings, and resource limits. */
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { isAbsolute, resolve } from 'node:path'
import { environmentIdSchema } from './protocol.ts'

const peer = z.object({
  environmentId: environmentIdSchema,
  url: z.url().transform((value) => {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('peer URL must be an origin without credentials')
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('peer URL requires HTTPS, except literal loopback HTTP')
    return url.origin
  }),
  tokenEnv: z.string().min(1),
  workspaces: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)),
})

const schema = z.object({
  stateDirectory: z.string().refine(isAbsolute, 'stateDirectory must be absolute'),
  label: z.string().min(1).max(128),
  provider: z.string().min(1),
  model: z.string().min(1),
  agentPreset: z.string().min(1),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  approvalPolicy: z.enum(['ask', 'never']),
  peers: z.array(peer).default([]),
  workspaces: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u), z.string().refine(isAbsolute, 'workspace must be absolute').transform(value => resolve(value))),
  requestTimeoutMs: z.number().int().positive().max(2147483647).default(15000),
  retryIntervalMs: z.number().int().positive().max(2147483647).default(5000),
  maxBytes: z.number().int().positive().default(1048576),
  maxTeams: z.number().int().positive().default(64),
  maxMembers: z.number().int().positive().default(16),
  maxTasks: z.number().int().positive().default(256),
  maxOperations: z.number().int().positive().default(2048),
})
/** Resolved deployment configuration. */
export type ResolvedConfig = z.infer<typeof schema>
/** Plugin configuration accepted by the Loader. */
export interface Config {
  /** Private absolute directory containing this installation's identity and ownership lock. */
  stateDirectory: string
  /** Human-readable installation label returned by discovery. */
  label: string
  /** Local default provider for new and resumed remote members. */
  provider: string
  /** Local default model for new and resumed remote members. */
  model: string
  /** Local agent composition mounted before a remote member is published. */
  agentPreset: string
  /** Initial filesystem confinement for a newly created remote member. */
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Initial human approval policy for a newly created remote member. */
  approvalPolicy: 'ask' | 'never'
  /** Project aliases mapped to existing absolute local directories. */
  workspaces: Record<string, string>
  /** Pairwise host grants; tokenEnv names a secret environment variable rather than containing the secret. */
  peers?: {
    /** Persisted UUID of the authorized peer. */
    environmentId: string
    /** HTTPS origin of the peer, or literal loopback HTTP for local use. */
    url: string
    /** Environment variable containing the pairwise bearer secret. */
    tokenEnv: string
    /** Project aliases this peer may use. */
    workspaces: string[]
  }[]
  /** Milliseconds allowed for discovery plus one operation. */
  requestTimeoutMs?: number
  /** Milliseconds between durable outbox retry passes. */
  retryIntervalMs?: number
  /** Maximum complete record, framed message, request, or response size in UTF-8 bytes. */
  maxBytes?: number
  /** Maximum teams coordinated by this installation. */
  maxTeams?: number
  /** Maximum members per team, including its lead. */
  maxMembers?: number
  /** Maximum retained tasks per team. */
  maxTasks?: number
  /** Maximum retained mutation receipts per team; exhaustion rejects additional mutations. */
  maxOperations?: number
}
/** Loader configuration; semantic validation runs before any route is installed. */
export const Config: s<Config> = s.object({
  stateDirectory: s.string().required(), label: s.string().required(),
  provider: s.string().required(), model: s.string().required(),
  agentPreset: s.string().required(),
  sandboxMode: s.union(['read-only', 'workspace-write', 'danger-full-access']).required(),
  approvalPolicy: s.union(['ask', 'never']).required(),
  peers: s.array(s.object({
    environmentId: s.string().required(), url: s.string().required(),
    tokenEnv: s.string().required(), workspaces: s.array(String).required(),
  })).default([]),
  workspaces: s.dict(String).required(),
  requestTimeoutMs: s.number().default(15000), retryIntervalMs: s.number().default(5000),
  maxBytes: s.number().default(1048576), maxTeams: s.number().default(64),
  maxMembers: s.number().default(16), maxTasks: s.number().default(256), maxOperations: s.number().default(2048),
})
/**
 * Resolve and validate all deployment values before activation.
 * @param input - Loader configuration.
 * @returns complete configuration with explicit limits.
 */
export function resolveConfig(input: Config): ResolvedConfig {
  const config = schema.parse(input)
  if (new Set(config.peers.map(item => item.environmentId)).size !== config.peers.length) throw new Error('duplicate peer environment identity')
  return config
}
