# Peer Harness Transports

English | [中文](peer.zh.md)

Types shared by peer transports, the `ctx.peers` registry, and the model-facing consumer. A peer is another DeepSeek Harness instance reached over a network; the [peer package group](../../packages/peer/README.md) owns each package's configuration and behavior, and the [peer control plane Agent Note](../../.agents/notes/implemented/feature/2026-09-12-peer-harness-control-plane.md) owns the rationale and rejected alternatives. This page records the cross-package types declared in [`packages/peer/peer/src/types.ts`](../../packages/peer/peer/src/types.ts) and the registry in [`packages/peer/peer/src/index.ts`](../../packages/peer/peer/src/index.ts).

## Transports

A transport is one configured peer Harness. It is a trusted same-process value registered on `ctx.peers` under its own `id`, and the registry keeps transports in registration order. The transport owns its protocol — request encoding, credential resolution, hostile-input validation at its wire boundary, and its own timeouts — and the registry never inspects a transport's payloads.

`listSessions` reads the peer's visible session rows without resuming an agent, `ask` admits one task and waits for that turn to end, and `transcript` reads one bounded tail of a peer session. Every method accepts the caller's `AbortSignal`; cancelling stops only the local wait, because a peer turn already admitted runs to its own end.

```ts type-equiv
/** One configured peer Harness plus its transport contract. */
interface PeerTransport {
  /** Configured peer name, unique across registered transports. */
  readonly id: string
  /** Read the peer's visible session rows without resuming any agent. */
  listSessions(signal?: AbortSignal): Promise<readonly PeerSessionSummary[]>
  /** Admit one task and wait for the peer turn to end. */
  ask(request: PeerAskRequest, signal?: AbortSignal): Promise<PeerAskResult>
  /** Read one bounded transcript tail from a peer session. */
  transcript(request: PeerTranscriptRequest, signal?: AbortSignal): Promise<readonly PeerMessage[]>
}
```

## Requests and results

`PeerAskRequest.prompt` is the complete task the peer receives, never this Harness's conversation. An `ask` creates a peer session unless `sessionId` names an existing one, and `cwd` plus `agentPreset` apply to a session this call creates. `mode` selects how the peer admits the prompt into its inbox, and `timeoutMs` bounds the wait for the turn to end.

```ts type-equiv
/** Request to run one task on a peer Harness. */
interface PeerAskRequest {
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
```

`PeerAskResult` reports the session the turn ran on, the final assistant text, the peer's own stop reason, how long the call waited, and the token accounting `PeerUsage` when the peer reported it. `stopReason` is `unknown` when the peer committed no terminal, and `answer` is absent when the turn ended without assistant text. A peer that ends no turn within the bound fails instead of returning a partial result.

```ts type-equiv
/** Token accounting reported by the peer for one completed turn. */
interface PeerUsage {
  /** Input tokens charged by the peer's provider for the turn. */
  readonly inputTokens: number | undefined
  /** Output tokens produced by the peer's provider for the turn. */
  readonly outputTokens: number | undefined
  /** Prompt tokens the peer's provider served from its cache. */
  readonly cacheReadTokens: number | undefined
}
```

```ts type-equiv
/** Outcome of one completed peer turn. */
interface PeerAskResult {
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
```

## Session reads

`PeerSessionSummary` reduces one published peer session to the fields a caller acts on locally: the peer-issued `sessionId` that follow-up calls pass back, the committed `title` and `cwd`, whether a turn is `running`, and the peer-local `updatedAt`. Absent optional fields stay absent rather than being defaulted here, because the peer owns its sessions.

```ts type-equiv
/**
 * One published session on a peer Harness, reduced to the fields a caller can
 * act on locally.
 */
interface PeerSessionSummary {
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
```

`PeerTranscriptRequest` bounds one tail read: `limit` caps the trailing messages and `maxChars` caps the text retained from each. `PeerMessage` is the reduced result — one human or assistant message carrying the text after that bound.

```ts type-equiv
/** Request for one bounded tail of a peer session transcript. */
interface PeerTranscriptRequest {
  /** Peer-issued session identity. */
  readonly sessionId: string
  /** Maximum trailing messages to return. */
  readonly limit?: number
  /** Maximum characters retained per message. */
  readonly maxChars?: number
}
```

```ts type-equiv
/** One human or assistant message read from a peer session. */
interface PeerMessage {
  /** Author of the message on the peer. */
  readonly role: 'user' | 'assistant'
  /** Message text after the transport's own bound. */
  readonly text: string
}
```

## Selection and failures

The registry resolves a peer name for every operation. A registered name selects that transport; omitting the name is legal only while exactly one transport is registered, and fails rather than guessing otherwise. `PeerError` carries the stable `PeerErrorCode`: `DUPLICATE_PEER` from registering a name already in use, `NO_PEER` when nothing matches, `AMBIGUOUS_PEER` when the name is omitted with several registered, and `SERVICE_DISPOSING` once the registry is torn down.

```ts type-equiv
/** Machine-routable peer service failures. */
type PeerErrorCode =
  | 'AMBIGUOUS_PEER'
  | 'DUPLICATE_PEER'
  | 'NO_PEER'
  | 'SERVICE_DISPOSING'
```

`register` contributes through `ctx.effect` and returns a disposer, so unloading a transport row removes exactly that peer while operations already holding it settle against the transport they hold. The shipped transport in [`packages/peer/peer-remote/src/remote.ts`](../../packages/peer/peer-remote/src/remote.ts) reports its own credential, envelope, and protocol failures as `RemotePeerError`; the model-facing tools in [`packages/peer/tool-peer/src/index.ts`](../../packages/peer/tool-peer/src/index.ts) bound every result before it reaches a model request.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeers--peerservice"></a>

### `ctx.peers` — `PeerService`

Registry of named peer Harness transports for one Host composition.

```ts cordis-catalog
/**
 * Register one peer transport for this effect scope.
 * @param transport - transport with a non-empty unique peer name.
 * @returns disposer that removes exactly this contribution.
 */
register(transport: PeerTransport): () => void

/**
 * List registered peer names in registration order.
 * @returns fresh peer names.
 */
list(): string[]

/**
 * Read one peer's visible session rows.
 * @param peer - registered peer name; omission requires exactly one peer.
 * @param signal - caller cancellation.
 * @returns peer session summaries ordered by the peer's own activity order.
 */
listSessions(peer: string | undefined, signal?: AbortSignal): Promise<readonly PeerSessionSummary[]>

/**
 * Run one task on a peer and wait for its turn to end.
 * @param peer - registered peer name; omission requires exactly one peer.
 * @param request - task text plus optional session, directory, preset, and bound.
 * @param signal - caller cancellation.
 * @returns the peer's terminal outcome for that turn.
 */
ask(peer: string | undefined, request: PeerAskRequest, signal?: AbortSignal): Promise<PeerAskResult>

/**
 * Read one bounded transcript tail from a peer session.
 * @param peer - registered peer name; omission requires exactly one peer.
 * @param request - target session and tail bounds.
 * @param signal - caller cancellation.
 * @returns peer messages oldest first within the requested tail.
 */
transcript(peer: string | undefined, request: PeerTranscriptRequest, signal?: AbortSignal): Promise<readonly PeerMessage[]>
```

Source: [`packages/peer/peer/src/index.ts`](../../packages/peer/peer/src/index.ts)
<!-- END GENERATED cordis-surface -->
