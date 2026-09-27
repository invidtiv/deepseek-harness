/** Operator pairing values; invitation secrets appear only in the creation response and redemption input. */
import type { Branded } from '@deepseek-ai/dsh-brand'
type EnvironmentId = Branded<'EnvironmentId'>

/** Opaque single-invitation identity. */
export type PairingInvitationId = Branded<'PairingInvitationId'>
/** Explicit permissions granted by one installation to its peer. */
export interface PairingGrants {
  workspaces: string[]
  workspaceManagement: boolean
  sessionAccess: boolean
  attachmentAccess: boolean
  approvalAccess: boolean
  terminalAccess: boolean
  teamAccess: boolean
  teamOperate: boolean
}
/** Identity and route pinned before an invitation is issued. */
export interface PairingTarget {
  environmentId: EnvironmentId
  url: string
}
/** Write-only material for replacing one configured peer credential. */
export interface PairingCredentialChange {
  environmentId: EnvironmentId
  secret: string
}
/** Invitation metadata returned by authenticated management reads. */
export interface PairingInvitationMetadata {
  id: PairingInvitationId
  target: PairingTarget
  grants: PairingGrants
  createdAt: number
  expiresAt: number
  status: 'pending' | 'redeeming' | 'consumed' | 'revoked' | 'expired'
}
/** Transfer this value privately to the intended installation. */
export interface PairingInvitation {
  id: PairingInvitationId
  issuer: PairingTarget
  target: PairingTarget
  expiresAt: number
  token: string
}
/** Persisted pairing acknowledgment contains no credential material. */
export interface PairingReceipt {
  environmentId: EnvironmentId
  peerId: EnvironmentId
  invitationId: PairingInvitationId
}

/** Recoverable outgoing pairing attempt, without its staged credential reference. */
export interface PairingAttemptMetadata {
  id: PairingInvitationId
  issuer: PairingTarget
  expiresAt: number
  status: 'pending' | 'committing' | 'complete'
}
