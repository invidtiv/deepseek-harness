/** Browser-safe coordinator dashboard requests and results. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

type EnvironmentId = Branded<'EnvironmentId'>
type TeamId = Branded<'DistributedTeamId'>
type OperationId = Branded<'EnvironmentTeamOperationId'>
/** Operator authority is independent of model team membership. */
export type TeamDashboardRequest =
  | { action: 'catalog' }
  | { action: 'read'; teamId: TeamId }
  | { action: 'interrupt'; teamId: TeamId; sessionId: SessionId }
/** Coordinator responses omit message bodies and mutation receipts. */
export type TeamDashboardResult =
  | { kind: 'catalog'; environmentId: EnvironmentId; teams: { teamId: TeamId; workspace: string; members: number; tasks: number; queuedMessages: number }[] }
  | { kind: 'team'
    environmentId: EnvironmentId
    teamId: TeamId
    workspace: string
    members: { environmentId: EnvironmentId; sessionId: SessionId; name: string; workspace: string }[]
    tasks: { id: OperationId; text: string; revision: number; status: 'pending' | 'in_progress' | 'completed'; owner?: string | undefined }[]
    outbox: { id: OperationId; sender: string; target: string }[] }
  | { kind: 'interrupted'; environmentId: EnvironmentId; teamId: TeamId; sessionId: SessionId; status: 'interrupt-requested' | 'inactive' }
