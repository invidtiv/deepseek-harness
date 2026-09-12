/**
 * Model-facing tools that drive other DeepSeek Harness instances through
 * `ctx.peers`. Each call is a complete task or a read of a peer's own session
 * log; nothing from the calling Harness is forwarded.
 * @module @deepseek-ai/dsh-tool-peer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PeerMessage, PeerSessionSummary } from '@deepseek-ai/dsh-peer'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-peer'

/** Required peer registry and tool registry. */
export const inject = ['peers', 'tools']

/** Default cap for one complete model-facing peer result. */
export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024

/** Smallest cap that preserves a peer identity and a truncation marker. */
export const MIN_MAX_RESULT_BYTES = 64

/** Model-facing peer tool configuration. */
export interface Config {
  /** Maximum UTF-8 bytes in one complete peer result. */
  maxResultBytes?: number
}

/** Schemastery configuration for the peer tool consumer. */
export const Config: z<Config> = z.object({
  maxResultBytes: z.number().step(1).min(MIN_MAX_RESULT_BYTES).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RESULT_BYTES),
})

interface AskArgs {
  prompt: string
  peer?: string
  cwd?: string
  session_id?: string
  agent_preset?: string
  timeout_ms?: number
}

interface SessionsArgs {
  peer?: string
  limit?: number
}

interface TranscriptArgs {
  session_id: string
  peer?: string
  limit?: number
}

const TRUNCATION_MARKER = '\n… [truncated]'

const USAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    cacheReadTokens: { type: 'integer' },
  },
} as const

const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    title: { type: 'string' },
    cwd: { type: 'string' },
    running: { type: 'boolean', required: true },
    updatedAt: { type: 'integer' },
  },
} as const

const ASK_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    answer: { type: 'string' },
    stopReason: { type: 'string', required: true },
    elapsedMs: { type: 'integer', required: true },
    usage: USAGE_SCHEMA,
  },
} as const

const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', required: true, enum: ['user', 'assistant'] },
    text: { type: 'string', required: true },
  },
} as const

/**
 * Bound one complete model-facing result at a UTF-8 boundary.
 * @param text - complete result text.
 * @param maxBytes - positive final byte cap.
 * @returns the text unchanged when it fits, otherwise a head slice plus a marker.
 */
function boundText(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return text
  const markerBytes = new TextEncoder().encode(TRUNCATION_MARKER).byteLength
  /* v8 ignore next -- Config floors maxResultBytes at MIN_MAX_RESULT_BYTES (64), above this 16-byte marker. */
  if (markerBytes >= maxBytes) return TRUNCATION_MARKER.slice(0, Math.max(0, maxBytes))
  let end = maxBytes - markerBytes
  /* v8 ignore next -- end starts below the encoded length and only decreases, so the read is always defined. */
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return `${new TextDecoder().decode(bytes.subarray(0, end))}${TRUNCATION_MARKER}`
}

interface UsageFields {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
}

interface AskResultFields {
  sessionId: string
  stopReason: string
  elapsedMs: number
  answer?: string
  usage?: UsageFields
}

function renderAsk(result: AskResultFields, maxBytes: number): ContentBlock[] {
  const answer = result.answer === undefined || result.answer.length === 0
    ? '(the peer ended the turn without assistant text)'
    : result.answer
  const facts = [
    result.stopReason,
    `${(result.elapsedMs / 1000).toFixed(1)}s`,
  ]
  if (result.usage !== undefined) {
    facts.push(`${result.usage.inputTokens ?? '?'} in / ${result.usage.outputTokens ?? '?'} out tokens`)
  }
  facts.push(result.sessionId)
  return [{ type: 'text', text: boundText(`${answer}\n\n[${facts.join(' | ')}]`, maxBytes) }]
}

function renderSessions(rows: readonly SessionSummaryFields[], maxBytes: number): ContentBlock[] {
  const header = rows.length === 0 ? 'no peer sessions' : `${rows.length} peer session(s)`
  const lines = rows.map(row => `- ${row.sessionId} | ${row.title === undefined ? '(untitled)' : JSON.stringify(row.title)}`
    + ` | ${row.cwd ?? '(no cwd)'} | ${row.running ? 'running' : 'idle'} | ${row.updatedAt ?? 'unknown'}ms`)
  return [{ type: 'text', text: boundText([header, ...lines].join('\n'), maxBytes) }]
}

function renderTranscript(messages: readonly PeerMessage[], maxBytes: number): ContentBlock[] {
  const header = messages.length === 0 ? 'no peer messages' : `${messages.length} peer message(s)`
  const blocks = messages.map(message => `[${message.role}] ${message.text}`)
  const body = blocks.length === 0 ? header : [header, ...blocks].join('\n\n')
  return [{ type: 'text', text: boundText(body, maxBytes) }]
}

interface SessionSummaryFields {
  sessionId: string
  running: boolean
  title?: string
  cwd?: string
  updatedAt?: number
}

/**
 * Project one peer session row into the model-facing result fields.
 * @param row - registry session summary.
 * @returns an object with absent optional fields omitted.
 */
function summaryFields(row: PeerSessionSummary): SessionSummaryFields {
  return {
    sessionId: row.sessionId,
    running: row.running,
    ...row.title === undefined ? {} : { title: row.title },
    ...row.cwd === undefined ? {} : { cwd: row.cwd },
    ...row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt },
  }
}

/** Register the peer tools with `ctx.tools`. */
export function apply(ctx: Context, config: Config): void {
  const maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES

  ctx.tools.register(defineTool({
    name: 'peer_ask',
    description: 'Run a task on a peer DeepSeek Harness and return its final answer. '
      + 'The peer works in its own checkout with its own model and tools; nothing from this conversation is shared, '
      + 'and it cannot see files on this machine. Creates a new peer session unless session_id names an existing one, '
      + 'and blocks until that turn ends.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the peer. It does not see this conversation.' },
      peer: { type: 'string', description: 'Configured peer name. Omit when only one peer is configured.' },
      cwd: { type: 'string', description: 'Absolute working directory on the peer machine for a new session.' },
      session_id: { type: 'string', description: 'Continue an existing peer session instead of creating one.' },
      agent_preset: { type: 'string', description: 'Peer agent preset for a new session, for example standard.' },
      timeout_ms: { type: 'integer', description: 'How long to wait for the peer turn to end, in milliseconds.' },
    },
    output: {
      schema: ASK_RESULT_SCHEMA,
      render: (_args, value) => renderAsk(value, maxResultBytes),
    },
    async execute(args: AskArgs, exec) {
      const result = await ctx.peers.ask(args.peer, {
        prompt: args.prompt,
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        ...args.session_id === undefined ? {} : { sessionId: args.session_id },
        ...args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset },
        ...args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms },
      }, exec.signal)
      return {
        sessionId: result.sessionId,
        stopReason: result.stopReason,
        elapsedMs: result.elapsedMs,
        ...result.answer === undefined ? {} : { answer: result.answer },
        ...result.usage === undefined ? {} : {
          usage: {
            ...result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens },
            ...result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens },
            ...result.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: result.usage.cacheReadTokens },
          },
        },
      }
    },
    presentCall: args => ({ card: 'generic', title: `Ask peer ${args.peer ?? ''}`.trim(), kind: 'execute', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'peer_sessions',
    description: 'List recent sessions on a peer DeepSeek Harness: session id, title, working directory, '
      + 'whether a turn is running, and last activity. Use it to find a session id for peer_transcript, '
      + 'or to continue earlier peer work with peer_ask.',
    parameters: {
      peer: { type: 'string', description: 'Configured peer name. Omit when only one peer is configured.' },
      limit: { type: 'integer', description: 'How many sessions to return, most recently active first.' },
    },
    output: {
      schema: { type: 'array', items: SESSION_SUMMARY_SCHEMA },
      render: (_args, value) => renderSessions(value, maxResultBytes),
    },
    async execute(args: SessionsArgs, exec) {
      const rows = await ctx.peers.listSessions(args.peer, exec.signal)
      const limit = args.limit ?? 15
      const sorted = [...rows].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      return sorted.slice(0, limit).map(summaryFields)
    },
    presentCall: () => ({ card: 'generic', title: 'List peer sessions', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'peer_transcript',
    description: 'Read the recent human and assistant messages of one session on a peer DeepSeek Harness, '
      + 'oldest first. Use it to see what a peer session concluded without re-running the work.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Peer session id, as returned by peer_sessions or peer_ask.' },
      peer: { type: 'string', description: 'Configured peer name. Omit when only one peer is configured.' },
      limit: { type: 'integer', description: 'How many trailing messages to return.' },
    },
    output: {
      schema: { type: 'array', items: MESSAGE_SCHEMA },
      render: (_args, value) => renderTranscript(value, maxResultBytes),
    },
    async execute(args: TranscriptArgs, exec) {
      const messages = await ctx.peers.transcript(args.peer, {
        sessionId: args.session_id,
        ...args.limit === undefined ? {} : { limit: args.limit },
      }, exec.signal)
      return messages.map(message => ({ role: message.role, text: message.text }))
    },
    presentCall: args => ({ card: 'generic', title: `Read peer session ${args.session_id}`, kind: 'read' }),
  }))
}
