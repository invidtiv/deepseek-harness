/** Browser-safe deployment configuration; credential values are stored separately. */
/** Plugin configuration accepted by the Loader. */
export interface EnvironmentTeamConfig {
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
  /** Pairwise host grants; tokenEnv names a local credential reference rather than containing the secret. */
  peers?: {
    /** Persisted UUID of the authorized peer. */
    environmentId: string
    /** HTTPS origin of the peer, or literal loopback HTTP for local use. */
    url: string
    /** Local credential reference containing the pairwise bearer secret. */
    tokenEnv: string
    /** Project aliases this peer may use. */
    workspaces: string[]
    /** Allow this peer to browse and register workspaces beneath its granted aliases. */
    workspaceManagement?: boolean
    /** Allow this peer to read and operate Sessions in its granted workspaces. */
    sessionAccess?: boolean
    /** Allow uploading and downloading attachments referenced by granted Sessions. */
    attachmentAccess?: boolean
    /** Allow answering pending approvals and questions for granted Sessions. */
    approvalAccess?: boolean
    /** Allow user-shell terminals in granted Sessions; shells run with the destination user's privileges. */
    terminalAccess?: boolean
    /** Read teams whose coordinator lead belongs to a granted workspace alias. */
    teamAccess?: boolean
    /** Interrupt non-lead members of readable coordinator-owned teams. */
    teamOperate?: boolean
  }[]
  /** Reachable origin advertised in pairing invitations; empty disables invitation creation. */
  publicUrl?: string
  /** Milliseconds a newly issued pairing invitation remains valid. */
  invitationLifetimeMs?: number
  /** Maximum retained incoming invitations and outgoing pairing attempts per installation. */
  maxInvitations?: number
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
  /** Maximum directory entries or workspace records returned in one view. */
  workspacePageSize?: number
  /** Maximum Session summaries or committed messages returned in one view. */
  sessionPageSize?: number
  /** Initial remote terminal width in character cells. */
  terminalCols?: number
  /** Initial remote terminal height in character cells. */
  terminalRows?: number
  /** Maximum decoded file upload bytes, also constrained by complete peer request limits. */
  maxUploadBytes?: number
  /** Milliseconds between Session catalog refreshes and disconnected follow retries. */
  sessionSyncIntervalMs?: number
  /** Milliseconds between authenticated peer stream heartbeats and credential rechecks. */
  sessionStreamHeartbeatMs?: number
  /** Milliseconds without a complete peer frame or heartbeat before reconnecting. */
  sessionStreamIdleTimeoutMs?: number
}
