/** Validated operator views of coordinator-owned teams. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamDashboardRequest, TeamDashboardResult } from './team-types.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'
type DistributedTeamId = Branded<'DistributedTeamId'>
type EnvironmentId = Branded<'EnvironmentId'>
type OperationId = Branded<'EnvironmentTeamOperationId'>

const teamId = z.string().min(1).max(256).transform(value => brandString<DistributedTeamId>(value))
const environmentId = z.uuid().transform(value => brandString<EnvironmentId>(value))
const sessionId = z.string().min(1).max(256).transform(SessionId)
const operationId = z.string().min(1).max(256).transform(value => brandString<OperationId>(value))
const alias = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
/** Requests use operator authority independently of model team membership. */
export const teamDashboardRequestSchema: z.ZodType<TeamDashboardRequest> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog') }).strict(),
  z.object({ action: z.literal('read'), teamId }).strict(),
  z.object({ action: z.literal('interrupt'), teamId, sessionId }).strict(),
])

const summary = z.object({ teamId, workspace: alias, members: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(), queuedMessages: z.number().int().nonnegative() }).strict()
/** Responses omit message bodies and mutation receipts. */
export const teamDashboardResultSchema: z.ZodType<TeamDashboardResult> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalog'), environmentId, teams: z.array(summary) }).strict(),
  z.object({ kind: z.literal('team'), environmentId, teamId, workspace: alias,
    members: z.array(z.object({ environmentId, sessionId, name: alias, workspace: alias }).strict()),
    tasks: z.array(z.object({ id: operationId, text: z.string(), revision: z.number().int().positive(),
      status: z.enum(['pending', 'in_progress', 'completed']), owner: alias.optional() }).strict()),
    outbox: z.array(z.object({ id: operationId, sender: alias, target: alias }).strict()),
  }).strict(),
  z.object({ kind: z.literal('interrupted'), environmentId, teamId, sessionId,
    status: z.enum(['interrupt-requested', 'inactive']) }).strict(),
])
