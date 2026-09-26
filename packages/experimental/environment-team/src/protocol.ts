/** Validated peer messages and durable distributed-team records. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { workspaceRequestSchema } from './workspace-protocol.ts'

/** Durable identity of one independently owned Harness installation. */
export type EnvironmentId = Branded<'EnvironmentId'>
/** Coordinator-owned team identity. */
export type DistributedTeamId = Branded<'DistributedTeamId'>
/** Retry identity for a command or delivery. */
export type OperationId = Branded<'EnvironmentTeamOperationId'>

/** Durable attribution for a message admitted by a distributed team's coordinator. */
export interface EnvironmentTeamMessageSource {
  /** Producer identity distinct from direct human input. */
  readonly kind: 'environment-team'
  /** Environment authenticating and coordinating this delivery. */
  readonly coordinator: EnvironmentId
  /** Coordinator-owned team containing the sender. */
  readonly teamId: DistributedTeamId
  /** Immutable sender name within that team. */
  readonly sender: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Informational coordinator attribution retained by readers without this plugin.
     * @persistenceAttribution
     */
    'environment-team': EnvironmentTeamMessageSource
  }
}

/** Validates an environment identity received from disk or a peer. */
export const environmentIdSchema = z.uuid().transform(value => brandString<EnvironmentId>(value))
const teamId = z.string().min(1).max(256).transform(value => brandString<DistributedTeamId>(value))
const operationId = z.string().min(1).max(256).transform(value => brandString<OperationId>(value))
const sessionId = z.string().min(1).max(256).transform(SessionId)
const alias = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)

/** Descriptor verified before a peer receives credentials or work. */
export const descriptorSchema = z.object({
  environmentId: environmentIdSchema,
  label: z.string(),
  platform: z.string(),
  protocol: z.literal(1),
  capabilities: z.object({ distributedTeams: z.literal(true), workspaceBrowser: z.literal(true).optional() }),
}).strict()
/** Public environment identity and compatible protocol capabilities. */
export type EnvironmentDescriptor = z.infer<typeof descriptorSchema>

/** A team member's location; session identifiers never select an environment. */
export const memberSchema = z.object({
  environmentId: environmentIdSchema,
  sessionId,
  name: alias,
  workspace: alias,
}).strict()

/** Commands accepted from a local model tool or an authenticated member host. */
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('spawn'), name: alias, environmentId: environmentIdSchema, workspace: alias, text: z.string().min(1) }).strict(),
  z.object({ action: z.literal('send'), target: alias, text: z.string().min(1) }).strict(),
  z.object({ action: z.literal('task-create'), text: z.string().min(1) }).strict(),
  z.object({ action: z.literal('task-update'), taskId: operationId, revision: z.number().int().positive(), status: z.enum(['pending', 'in_progress', 'completed']) }).strict(),
  z.object({ action: z.literal('interrupt'), target: alias }).strict(),
])
/** Validated distributed-team command. */
export type TeamCommand = z.infer<typeof commandSchema>
/** Validated member address. */
export type Member = z.infer<typeof memberSchema>

const taskSchema = z.object({
  id: operationId, text: z.string(), revision: z.number().int().positive(),
  status: z.enum(['pending', 'in_progress', 'completed']), owner: alias.optional(),
}).strict()
const messageSchema = z.object({ id: operationId, sender: alias, target: alias, text: z.string() }).strict()
/** Coordinator record; one update commits a command and its retry receipt together. */
export const teamSchema = z.object({
  id: teamId, members: z.array(memberSchema), tasks: z.array(taskSchema),
  pending: z.array(messageSchema),
  receipts: z.array(z.object({
    id: operationId, actor: sessionId, environmentId: environmentIdSchema,
    fingerprint: z.string(), result: z.string(),
  }).strict()),
}).strict()
/** Authoritative coordinator state. */
export type Team = z.infer<typeof teamSchema>
/** An outgoing message retained until durable target acceptance. */
export type Delivery = z.infer<typeof messageSchema>

/** Receiver-owned assignment written before a remote Session is created. */
export const assignmentSchema = z.object({
  coordinator: environmentIdSchema, teamId, member: memberSchema,
}).strict()
/** Local Session's membership in a distributed team. */
export type Assignment = z.infer<typeof assignmentSchema>

/** Authenticated peer request. The receiver checks target identity before dispatch. */
export const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), environmentId: environmentIdSchema, request: workspaceRequestSchema }).strict(),
  z.object({ kind: z.literal('command'), environmentId: environmentIdSchema, teamId, actor: sessionId, operationId, command: commandSchema }).strict(),
  z.object({ kind: z.literal('deliver'), environmentId: environmentIdSchema, assignment: assignmentSchema, message: messageSchema }).strict(),
  z.object({ kind: z.literal('interrupt'), environmentId: environmentIdSchema, teamId, sessionId }).strict(),
])
/** Peer request after JSON validation. */
export type PeerRequest = z.infer<typeof requestSchema>
