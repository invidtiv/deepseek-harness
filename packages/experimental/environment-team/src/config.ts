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
  workspaceManagement: z.boolean().default(false),
  sessionAccess: z.boolean().default(false),
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
  workspacePageSize: z.number().int().positive().default(100),
  sessionPageSize: z.number().int().positive().default(100),
  sessionSyncIntervalMs: z.number().int().positive().max(2147483647).default(2000),
})
/** Resolved deployment configuration. */
export type ResolvedConfig = z.infer<typeof schema>
import type { EnvironmentTeamConfig } from './config-types.ts'
/** Plugin configuration accepted by the Loader. */
export type Config = EnvironmentTeamConfig
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
    workspaceManagement: s.boolean().default(false),
    sessionAccess: s.boolean().default(false),
  })).default([]),
  workspaces: s.dict(String).required(),
  requestTimeoutMs: s.number().default(15000), retryIntervalMs: s.number().default(5000),
  maxBytes: s.number().default(1048576), maxTeams: s.number().default(64),
  maxMembers: s.number().default(16), maxTasks: s.number().default(256), maxOperations: s.number().default(2048),
  workspacePageSize: s.number().default(100),
  sessionPageSize: s.number().default(100),
  sessionSyncIntervalMs: s.number().default(2000),
})
/**
 * Resolve and validate all deployment values before activation.
 * @param input - Loader configuration.
 * @returns complete configuration with explicit limits.
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  const config = schema.parse(input)
  if (new Set(config.peers.map(item => item.environmentId)).size !== config.peers.length) throw new Error('duplicate peer environment identity')
  return config
}
