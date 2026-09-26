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
  /** Maximum directory entries or workspace records returned in one view. */
  workspacePageSize?: number
}
