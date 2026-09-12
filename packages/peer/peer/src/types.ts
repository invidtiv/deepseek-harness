/**
 * Types shared by peer transports, the `ctx.peers` registry, and tool
 * consumers. Runtime service code lives in `./index.ts`.
 * @module @deepseek-ai/dsh-peer/types
 */

/**
 * One published session on a peer Harness, reduced to the fields a caller can
 * act on locally.
 */
export interface PeerSessionSummary {
  /** Peer-issued session identity, opaque to this Harness. */
  readonly sessionId: string
  /** Committed session title, when the peer has recorded one. */
  readonly title: string | undefined
  /** Working directory the peer session runs in. */
  readonly cwd: string | undefined
  /** Whether the peer reports an active turn for this session. */
  readonly running: boolean
  /** Peer-local last-activity time in epoch milliseconds. */
  readonly updatedAt: number | undefined
}

/** Token accounting reported by the peer for one completed turn. */
export interface PeerUsage {
  /** Input tokens charged by the peer's provider for the turn. */
  readonly inputTokens: number | undefined
  /** Output tokens produced by the peer's provider for the turn. */
  readonly outputTokens: number | undefined
  /** Prompt tokens the peer's provider served from its cache. */
  readonly cacheReadTokens: number | undefined
}

/** Request to run one task on a peer Harness. */
export interface PeerAskRequest {
  /** The complete task text handed to the peer; never this Harness's history. */
  readonly prompt: string
  /** Absolute working directory on the peer machine for a new session. */
  readonly cwd?: string
  /** Existing peer session to continue instead of creating one. */
  readonly sessionId?: string
  /** Peer agent preset for a new session. */
  readonly agentPreset?: string
  /** How the peer admits the prompt into its inbox. */
  readonly mode?: 'queue' | 'steer'
  /** Bound on waiting for the peer turn to end. */
  readonly timeoutMs?: number
}

/** Outcome of one completed peer turn. */
export interface PeerAskResult {
  /** Session the turn ran on. */
  readonly sessionId: string
  /** Final assistant text of the turn, absent when the peer committed none. */
  readonly answer: string | undefined
  /** Peer-reported turn terminal, or `unknown` when the peer omitted one. */
  readonly stopReason: string
  /** Wall-clock milliseconds between prompt admission and turn end. */
  readonly elapsedMs: number
  /** Token accounting when the peer reported it. */
  readonly usage: PeerUsage | undefined
}

/** One human or assistant message read from a peer session. */
export interface PeerMessage {
  /** Author of the message on the peer. */
  readonly role: 'user' | 'assistant'
  /** Message text after the transport's own bound. */
  readonly text: string
}

/** Request for one bounded tail of a peer session transcript. */
export interface PeerTranscriptRequest {
  /** Peer-issued session identity. */
  readonly sessionId: string
  /** Maximum trailing messages to return. */
  readonly limit?: number
  /** Maximum characters retained per message. */
  readonly maxChars?: number
}

/** One configured peer Harness plus its transport contract. */
export interface PeerTransport {
  /** Configured peer name, unique across registered transports. */
  readonly id: string
  /** Read the peer's visible session rows without resuming any agent. */
  listSessions(signal?: AbortSignal): Promise<readonly PeerSessionSummary[]>
  /** Admit one task and wait for the peer turn to end. */
  ask(request: PeerAskRequest, signal?: AbortSignal): Promise<PeerAskResult>
  /** Read one bounded transcript tail from a peer session. */
  transcript(request: PeerTranscriptRequest, signal?: AbortSignal): Promise<readonly PeerMessage[]>
}
