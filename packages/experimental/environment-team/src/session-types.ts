/** Browser-safe operations for destination-owned ordinary Sessions. */
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'environment/session-denied': Record<string, never>
    'environment/session-unsupported': Record<string, never>
    'environment/session-protocol': Record<string, never>
    'environment/session-unavailable': Record<string, never>
  }
}

type WorkspaceId = Branded<'WorkspaceId'>
type EnvironmentId = Branded<'EnvironmentId'>

/** Requests never accept a caller filesystem path or model credential. */
export type SessionRequest =
  | { readonly action: 'list'; readonly workspaceId: WorkspaceId }
  | { readonly action: 'create'; readonly workspaceId: WorkspaceId; readonly sessionId: SessionId }
  | { readonly action: 'read'; readonly workspaceId: WorkspaceId; readonly sessionId: SessionId }
  | { readonly action: 'cancel'; readonly workspaceId: WorkspaceId; readonly sessionId: SessionId }
  | { readonly action: 'prompt'; readonly workspaceId: WorkspaceId; readonly sessionId: SessionId; readonly requestId: SessionRequestId; readonly text: string }

/** Ordinary Session addressed within its destination workspace. */
export interface EnvironmentSessionFollowRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

/** Full replacement view; live assistant text is process-local and never becomes a copied Session log. */
export type EnvironmentSessionFrame = Extract<SessionResult, { kind: 'snapshot' }> & {
  readonly live?: { readonly attemptId: LlmAttemptId; readonly text: string } | undefined
}

/** One completed, committed text message; tool and attachment details remain on the owning Web app. */
export interface EnvironmentSessionMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** One ordinary Session currently attached to the addressed workspace. */
export interface EnvironmentSessionSummary {
  readonly sessionId: SessionId
  readonly title: string
  readonly running: boolean
  readonly updatedAt: number
}

/** Every response retains both destination identities, including empty lists. */
export type SessionResult = {
  readonly environmentId: EnvironmentId
  readonly workspaceId: WorkspaceId
} & (
  | { readonly kind: 'sessions'; readonly sessions: readonly EnvironmentSessionSummary[]; readonly truncated: boolean }
  | { readonly kind: 'created'; readonly sessionId: SessionId }
  | { readonly kind: 'accepted'; readonly sessionId: SessionId }
  | { readonly kind: 'cancelled'; readonly sessionId: SessionId }
  | { readonly kind: 'snapshot'; readonly sessionId: SessionId; readonly cursor: number; readonly running: boolean; readonly messages: readonly EnvironmentSessionMessage[]; readonly truncated: boolean }
)
