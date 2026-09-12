# Peer Harness 传输

[English](peer.md) | 中文

peer 传输、`ctx.peers` 注册表与面向模型消费方共享的类型。peer 是经网络到达的另一个 DeepSeek Harness 实例；[peer 包组](../../packages/peer/README.zh.md)负责每个包的配置与行为，[peer 控制平面 Agent Note](../../.agents/notes/implemented/feature/2026-09-12-peer-harness-control-plane.zh.md)负责决策依据与被否决的备选方案。本页记录 [`packages/peer/peer/src/types.ts`](../../packages/peer/peer/src/types.ts) 中声明的跨包类型，以及 [`packages/peer/peer/src/index.ts`](../../packages/peer/peer/src/index.ts) 中的注册表。

## 传输

一个传输就是一个已配置的 peer Harness。它是注册在 `ctx.peers` 上、以自身 `id` 为键的受信任同进程值，注册表按注册顺序保存传输。传输拥有自己的协议——请求编码、凭据解析、协议边界上的恶意输入校验，以及自己的超时——注册表从不检查传输的负载。

`listSessions` 在不恢复 agent 的情况下读取 peer 可见的会话行，`ask` 接纳一个任务并等待该轮次结束，`transcript` 读取 peer 会话的一段有界尾部。每个方法都接受调用方的 `AbortSignal`；取消只停止本地等待，因为一个已被接纳的 peer 轮次会运行到它自己的结束。

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

## 请求与结果

`PeerAskRequest.prompt` 是 peer 收到的完整任务，绝不是本 Harness 的对话。除非 `sessionId` 指明一个既有会话，否则一次 `ask` 会创建 peer 会话，而 `cwd` 与 `agentPreset` 作用于本次调用创建的会话。`mode` 选择 peer 把提示词接纳进其收件箱的方式，`timeoutMs` 限制等待轮次结束的时间。

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

`PeerAskResult` 报告该轮次运行所在的会话、最终 assistant 文本、peer 自己的结束原因、调用等待了多久，以及 peer 上报时的 token 计量 `PeerUsage`。当 peer 未提交任何终态时 `stopReason` 为 `unknown`，当轮次结束时没有 assistant 文本时 `answer` 缺失。在边界内始终不结束任何轮次的 peer 会失败，而不是返回部分结果。

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

## 会话读取

`PeerSessionSummary` 把一个已发布的 peer 会话缩减为调用方在本地据以行动的字段：后续调用回传的 peer 签发的 `sessionId`、已提交的 `title` 与 `cwd`、是否有轮次正在 `running`，以及 peer 本地的 `updatedAt`。缺失的可选字段保持缺失，而不在此处取默认值，因为 peer 拥有其会话。

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

`PeerTranscriptRequest` 限制一次尾部读取：`limit` 限制尾部消息数量，`maxChars` 限制每条消息保留的文本。`PeerMessage` 是缩减后的结果——一条携带该限界之后文本的人类或 assistant 消息。

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

## 选择与失败

注册表为每项操作解析一个 peer 名称。已注册的名称会选择该传输；只有在恰好注册了一个传输时才可以省略名称，否则会失败，而不是猜测。`PeerError` 携带稳定的 `PeerErrorCode`：注册一个已在使用的名称时得到 `DUPLICATE_PEER`，没有任何匹配时得到 `NO_PEER`，在注册了多个的情况下省略名称时得到 `AMBIGUOUS_PEER`，注册表被拆除后得到 `SERVICE_DISPOSING`。

```ts type-equiv
/** Machine-routable peer service failures. */
type PeerErrorCode =
  | 'AMBIGUOUS_PEER'
  | 'DUPLICATE_PEER'
  | 'NO_PEER'
  | 'SERVICE_DISPOSING'
```

`register` 通过 `ctx.effect` 贡献并返回一个 disposer，因此卸载一个传输行只会移除那一个 peer，而已经持有它的操作会针对它们所持有的传输结算。随附的传输位于 [`packages/peer/peer-remote/src/remote.ts`](../../packages/peer/peer-remote/src/remote.ts)，它把自己的凭据、信封与协议失败报告为 `RemotePeerError`；[`packages/peer/tool-peer/src/index.ts`](../../packages/peer/tool-peer/src/index.ts) 中的面向模型工具会在每个结果到达模型请求之前对其限界。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
