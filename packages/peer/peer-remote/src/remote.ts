/**
 * HTTP transport for one peer Harness. It speaks the peer's Remote API over
 * `/api`, authenticating with a browser-session cookie resolved per request.
 * @module @deepseek-ai/dsh-peer-remote/remote
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type {
  PeerAskRequest,
  PeerAskResult,
  PeerMessage,
  PeerSessionSummary,
  PeerTranscriptRequest,
  PeerTransport,
  PeerUsage,
} from '@deepseek-ai/dsh-peer'

/** Protocol or credential failure raised by one peer request. */
export class RemotePeerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemotePeerError'
  }
}

/** Construction inputs for {@link RemotePeerTransport}. */
export interface RemotePeerTransportOptions {
  /** Registered peer name. */
  readonly peerId: string
  /** Peer web origin, without a trailing slash. */
  readonly baseUrl: string
  /** Resolve the peer's browser-session cookie for one request. */
  readonly resolveCookie: () => Promise<string>
  /** Working directory used when a request names none. */
  readonly defaultCwd: string | undefined
  /** Agent preset used when a request names none. */
  readonly defaultAgentPreset: string | undefined
  /** Bound on one unary Remote call. */
  readonly requestTimeoutMs: number
  /** Bound on waiting for one peer turn to end. */
  readonly askTimeoutMs: number
  /** Delay between turns of the completion poll. */
  readonly pollIntervalMs: number
}

interface SessionRow {
  readonly sessionId: string
  readonly title: string | undefined
  readonly cwd: string | undefined
  readonly running: boolean
  readonly updatedAt: number | undefined
  readonly cursor: number
}

interface EventView {
  readonly seq: number | undefined
  readonly type: string
  readonly data: unknown
}

const RESERVED_LIST_ARGS: readonly Record<string, unknown>[] = [{ _request: {} }, { request: {} }]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

function textOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
    return [block.text]
  })
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** HTTP transport for one peer Harness, speaking its Remote API with a browser-session cookie. */
export class RemotePeerTransport implements PeerTransport {
  private readonly peerId: string
  private readonly baseUrl: string

  constructor(private readonly options: RemotePeerTransportOptions) {
    this.peerId = options.peerId
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
  }

  get id(): string {
    return this.peerId
  }

  /**
   * Read the peer's session rows without resuming any agent.
   * @param signal - caller cancellation.
   * @returns peer session summaries in the peer's own order.
   */
  async listSessions(signal?: AbortSignal): Promise<readonly PeerSessionSummary[]> {
    return (await this.listRows(signal)).map(row => ({
      sessionId: row.sessionId,
      title: row.title,
      cwd: row.cwd,
      running: row.running,
      updatedAt: row.updatedAt,
    }))
  }

  /**
   * Admit one task on the peer and wait for that turn to end.
   * @param request - task text plus optional session, directory, preset, and bounds.
   * @param signal - caller cancellation.
   * @returns the peer's terminal outcome for the turn.
   */
  async ask(request: PeerAskRequest, signal?: AbortSignal): Promise<PeerAskResult> {
    if (request.prompt.trim().length === 0) throw new RemotePeerError(`peer "${this.peerId}" needs non-empty prompt text`)
    const started = Date.now()
    const sessionId = request.sessionId ?? await this.createSession(request, signal)
    const before = (await this.listRows(signal)).find(row => row.sessionId === sessionId)
    const startSeq = before?.cursor ?? 0
    const timeoutMs = request.timeoutMs ?? this.options.askTimeoutMs
    const deadline = started + timeoutMs

    await this.prompt(sessionId, request, signal)

    while (Date.now() < deadline) {
      await delay(this.options.pollIntervalMs, signal)
      const row = (await this.listRows(signal)).find(item => item.sessionId === sessionId)
      if (row === undefined || row.cursor <= startSeq) continue
      const events = await this.page(sessionId, row.cursor, signal)
      let answer: string | undefined
      let stopReason: string | undefined
      let usage: PeerUsage | undefined
      for (const event of events) {
        if (event.seq !== undefined && event.seq <= startSeq) continue
        if (event.type === 'assistant/message') {
          const data = isRecord(event.data) ? event.data : undefined
          const text = textOf(data?.message !== undefined && isRecord(data.message) ? data.message.content : data?.content)
          if (text !== undefined) answer = text
        } else if (event.type === 'assistant/chunk') {
          usage = readUsage(event.data) ?? usage
        } else if (event.type === 'turn/end') {
          const data = isRecord(event.data) ? event.data : undefined
          const reason = isRecord(data?.reason) ? data.reason : undefined
          stopReason = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
        }
      }
      if (stopReason !== undefined) {
        return {
          sessionId,
          answer,
          stopReason,
          elapsedMs: Date.now() - started,
          usage,
        }
      }
    }
    throw new RemotePeerError(`peer "${this.peerId}" session ${sessionId} produced no turn end within ${timeoutMs}ms`)
  }

  /**
   * Read one bounded transcript tail from a peer session.
   * @param request - target session and tail bounds.
   * @param signal - caller cancellation.
   * @returns peer messages oldest first within the requested tail.
   */
  async transcript(request: PeerTranscriptRequest, signal?: AbortSignal): Promise<readonly PeerMessage[]> {
    if (request.sessionId.length === 0) throw new RemotePeerError(`peer "${this.peerId}" needs a non-empty session id`)
    const row = (await this.listRows(signal)).find(item => item.sessionId === request.sessionId)
    if (row === undefined) throw new RemotePeerError(`peer "${this.peerId}" has no session ${request.sessionId}`)
    const events = await this.page(request.sessionId, row.cursor, signal)
    const limit = request.limit ?? 10
    const maxChars = request.maxChars ?? 2000
    const messages: PeerMessage[] = []
    for (const event of events) {
      const data = isRecord(event.data) ? event.data : undefined
      if (event.type === 'user/message') {
        const source = isRecord(data?.source) ? data.source : undefined
        if (source?.kind !== 'user') continue
        const text = textOf(data?.content)
        if (text !== undefined) messages.push({ role: 'user', text: clip(text, maxChars) })
      } else if (event.type === 'assistant/message') {
        const message = isRecord(data?.message) ? data.message : undefined
        const text = textOf(message?.content ?? data?.content)
        if (text !== undefined) messages.push({ role: 'assistant', text: clip(text, maxChars) })
      }
    }
    return messages.slice(-limit)
  }

  private async createSession(request: PeerAskRequest, signal?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = {}
    const cwd = request.cwd ?? this.options.defaultCwd
    if (cwd !== undefined) body.cwd = cwd
    const preset = request.agentPreset ?? this.options.defaultAgentPreset
    if (preset !== undefined) body.agentPreset = preset
    const value = await this.call('session/create', { request: body }, signal)
    const sessionId = isRecord(value) ? readString(value, 'sessionId') : undefined
    if (sessionId === undefined) {
      throw new RemotePeerError(`peer "${this.peerId}" answered session/create without a session id`)
    }
    return sessionId
  }

  private async prompt(sessionId: string, request: PeerAskRequest, signal?: AbortSignal): Promise<void> {
    await this.call('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: request.mode ?? 'queue',
        content: [{ type: 'text', text: request.prompt }],
      },
    }, signal)
  }

  private async listRows(signal?: AbortSignal): Promise<readonly SessionRow[]> {
    let failure: unknown
    for (const args of RESERVED_LIST_ARGS) {
      try {
        return parseSessionRows(await this.call('session/list', args, signal))
      } catch (error: unknown) {
        if (failure === undefined) failure = error
      }
    }
    throw failure
  }

  private async page(sessionId: string, throughSeq: number, signal?: AbortSignal): Promise<readonly EventView[]> {
    const value = await this.call('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 80 },
    }, signal)
    return parseEventViews(value)
  }

  private async call(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const rpcId = randomUUID()
    const cookie = await this.options.resolveCookie()
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        redirect: 'error',
        signal: combined,
      })
    } catch (error: unknown) {
      throw new RemotePeerError(`peer "${this.peerId}" request ${endpoint} failed: ${messageOf(error)}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new RemotePeerError(`peer "${this.peerId}" refused the credential (HTTP ${response.status})`)
    }
    if (!response.ok) {
      throw new RemotePeerError(`peer "${this.peerId}" answered HTTP ${response.status} on ${endpoint}`)
    }
    const body: unknown = await response.json()
    if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId) {
      throw new RemotePeerError(`peer "${this.peerId}" answered ${endpoint} outside the Remote envelope`)
    }
    const result = isRecord(body.result) ? body.result : undefined
    if (result?.ok !== true) {
      const error = isRecord(result?.error) ? result.error : undefined
      const code = typeof error?.code === 'string' ? error.code : 'unknown'
      const detail = typeof error?.message === 'string' ? error.message : 'no detail'
      throw new RemotePeerError(`${endpoint} -> ${code}: ${detail}`)
    }
    return result.value
  }
}

function parseSessionRows(value: unknown): readonly SessionRow[] {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : undefined
  if (items === undefined) throw new RemotePeerError('session/list did not return an items array')
  return items.flatMap((item) => {
    if (!isRecord(item)) return []
    const sessionId = readString(item, 'sessionId')
    if (sessionId === undefined) return []
    const projections = isRecord(item.projections) ? item.projections : undefined
    const values = isRecord(projections?.values) ? projections.values : undefined
    const cursor = typeof projections?.asOfSeq === 'number' ? projections.asOfSeq : 0
    return [{
      sessionId,
      title: typeof values?.title === 'string' ? values.title : undefined,
      cwd: readString(item, 'cwd'),
      running: item.running === true,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
      cursor,
    }]
  })
}

function parseEventViews(value: unknown): readonly EventView[] {
  const records = isRecord(value) && Array.isArray(value.records) ? value.records : undefined
  if (records === undefined) throw new RemotePeerError('session/page did not return a records array')
  return records.flatMap((record) => {
    if (!isRecord(record)) return []
    const event = isRecord(record.event) ? record.event : record
    const type = readString(event, 'type')
    if (type === undefined) return []
    return [{ seq: typeof event.seq === 'number' ? event.seq : undefined, type, data: event.data }]
  })
}

function readUsage(value: unknown): PeerUsage | undefined {
  if (!isRecord(value)) return undefined
  const chunk = isRecord(value.chunk) ? value.chunk : undefined
  if (chunk?.type !== 'usage' || !isRecord(chunk.usage)) return undefined
  const usage = chunk.usage
  return {
    inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
    outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
    cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined,
  }
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… [${text.length - maxChars} more chars]`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
  signal?.throwIfAborted()
}
