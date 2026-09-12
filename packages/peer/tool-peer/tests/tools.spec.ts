import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import PeerService from '@deepseek-ai/dsh-peer'
import type {
  PeerAskRequest,
  PeerAskResult,
  PeerMessage,
  PeerSessionSummary,
  PeerTranscriptRequest,
  PeerTransport,
} from '@deepseek-ai/dsh-peer'
import * as ToolPeer from '@deepseek-ai/dsh-tool-peer'

const testToolSignal = new AbortController().signal

/** Scripted peer state one stub transport serves and the arguments it received. */
interface PeerScene {
  sessions: readonly PeerSessionSummary[]
  answer: PeerAskResult
  messages: readonly PeerMessage[]
  readonly asks: PeerAskRequest[]
  readonly transcripts: PeerTranscriptRequest[]
  listed: number
}

function scene(changes: Partial<Pick<PeerScene, 'sessions' | 'answer' | 'messages'>> = {}): PeerScene {
  return {
    sessions: [],
    answer: { sessionId: 'peer-session', answer: 'peer answer', stopReason: 'end', elapsedMs: 1_000, usage: undefined },
    messages: [],
    asks: [],
    transcripts: [],
    listed: 0,
    ...changes,
  }
}

function sceneTransport(id: string, state: PeerScene): PeerTransport {
  return {
    id,
    listSessions() {
      state.listed += 1
      return Promise.resolve(state.sessions)
    },
    ask(request) {
      state.asks.push(request)
      return Promise.resolve(state.answer)
    },
    transcript(request) {
      state.transcripts.push(request)
      return Promise.resolve(state.messages)
    },
  }
}

/** Mount the real prompt, tool, and peer registries with scripted peer transports. */
async function mountContext(peers: Readonly<Record<string, PeerScene>>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PeerService)
  for (const [id, state] of Object.entries(peers)) ctx.peers.register(sceneTransport(id, state))
  return ctx
}

function callerOf(ctx: Context): (name: string, args: unknown) => Promise<ToolExecutionResult> {
  let counter = 0
  return (name, args) => ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`peer-call-${++counter}`),
    name,
    arguments: args,
  })
}

async function mount(
  config: ToolPeer.Config = {},
  peers: Readonly<Record<string, PeerScene>> = {},
): Promise<{ ctx: Context; call: (name: string, args: unknown) => Promise<ToolExecutionResult> }> {
  const ctx = await mountContext(peers)
  await ctx.plugin(ToolPeer, config)
  return { ctx, call: callerOf(ctx) }
}

/** Apply the plugin directly, bypassing the Cordis config schema so `apply` sees no configured cap. */
async function mountApplied(
  peers: Readonly<Record<string, PeerScene>> = {},
): Promise<{ ctx: Context; call: (name: string, args: unknown) => Promise<ToolExecutionResult> }> {
  const ctx = await mountContext(peers)
  ToolPeer.apply(ctx, {})
  return { ctx, call: callerOf(ctx) }
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const TRUNCATION_MARKER = '\n… [truncated]'

describe('peer tool registration', () => {
  it('is a named function plugin that registers the three peer tools', async () => {
    expect('default' in ToolPeer).toBe(false)
    expect(ToolPeer.name).toBe('tool-peer')
    expect(ToolPeer.inject).toEqual(['peers', 'tools'])

    const { ctx } = await mount()

    expect(ctx.tools.get('peer_ask')).toBeDefined()
    expect(ctx.tools.get('peer_sessions')).toBeDefined()
    expect(ctx.tools.get('peer_transcript')).toBeDefined()
  })

  it('declares generic presentation for each peer tool', async () => {
    const { ctx } = await mount()

    expect(ctx.tools.get('peer_ask')?.presentCall?.({ prompt: 'x', peer: 'build-box' }))
      .toMatchObject({ card: 'generic', title: 'Ask peer build-box', kind: 'execute' })
    expect(ctx.tools.get('peer_ask')?.presentCall?.({ prompt: 'x' }))
      .toMatchObject({ card: 'generic', title: 'Ask peer' })
    expect(ctx.tools.get('peer_sessions')?.presentCall?.({}))
      .toMatchObject({ card: 'generic', title: 'List peer sessions', kind: 'read' })
    expect(ctx.tools.get('peer_transcript')?.presentCall?.({ session_id: 's1' }))
      .toMatchObject({ card: 'generic', title: 'Read peer session s1', kind: 'read' })
  })
})

describe('peer_ask', () => {
  it('renders the peer answer with its outcome facts and omits absent fields', async () => {
    const state = scene({
      answer: {
        sessionId: 'peer-1',
        answer: 'built the release',
        stopReason: 'end',
        elapsedMs: 1_500,
        usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: undefined },
      },
    })
    const { call } = await mount({}, { 'build-box': state })

    const result = await call('peer_ask', { prompt: 'build it', peer: 'build-box' })

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('built the release\n\n[end | 1.5s | 12 in / 3 out tokens | peer-1]')
    expect(result.value).toStrictEqual({
      sessionId: 'peer-1',
      stopReason: 'end',
      elapsedMs: 1_500,
      answer: 'built the release',
      usage: { inputTokens: 12, outputTokens: 3 },
    })
    expect(state.asks).toEqual([{ prompt: 'build it' }])
  })

  it('renders a fixed line when the peer ends the turn without assistant text', async () => {
    const silent = scene({
      answer: { sessionId: 'peer-2', answer: undefined, stopReason: 'unknown', elapsedMs: 400, usage: undefined },
    })
    const empty = scene({
      answer: { sessionId: 'peer-3', answer: '', stopReason: 'aborted', elapsedMs: 100, usage: undefined },
    })
    const { call } = await mount({}, { silent, empty })

    const silentResult = await call('peer_ask', { prompt: 'x', peer: 'silent' })
    expect(text(silentResult)).toBe('(the peer ended the turn without assistant text)\n\n[unknown | 0.4s | peer-2]')
    expect(silentResult.value).toStrictEqual({ sessionId: 'peer-2', stopReason: 'unknown', elapsedMs: 400 })

    const emptyResult = await call('peer_ask', { prompt: 'x', peer: 'empty' })
    expect(text(emptyResult)).toBe('(the peer ended the turn without assistant text)\n\n[aborted | 0.1s | peer-3]')
    expect(emptyResult.value).toStrictEqual({ sessionId: 'peer-3', stopReason: 'aborted', elapsedMs: 100, answer: '' })
  })

  it('forwards every optional argument to the peer registry', async () => {
    const state = scene()
    const { call } = await mount({}, { 'build-box': state })

    await call('peer_ask', {
      prompt: 'x',
      peer: 'build-box',
      cwd: '/srv/work',
      session_id: 'session-9',
      agent_preset: 'minimal',
      timeout_ms: 1_234,
    })

    expect(state.asks).toEqual([{
      prompt: 'x',
      cwd: '/srv/work',
      sessionId: 'session-9',
      agentPreset: 'minimal',
      timeoutMs: 1_234,
    }])
  })

  it('omits the usage fields the peer did not report', async () => {
    const state = scene({
      answer: {
        sessionId: 'peer-7',
        answer: 'counted',
        stopReason: 'end',
        elapsedMs: 1_000,
        usage: { inputTokens: undefined, outputTokens: undefined, cacheReadTokens: 7 },
      },
    })
    const { call } = await mount({}, { 'build-box': state })

    const result = await call('peer_ask', { prompt: 'x' })

    expect(text(result)).toBe('counted\n\n[end | 1.0s | ? in / ? out tokens | peer-7]')
    expect(result.value).toStrictEqual({
      sessionId: 'peer-7',
      stopReason: 'end',
      elapsedMs: 1_000,
      answer: 'counted',
      usage: { cacheReadTokens: 7 },
    })
  })
})

describe('peer_sessions', () => {
  it('renders rows newest first and omits absent optional fields', async () => {
    const state = scene({
      sessions: [
        { sessionId: 's-old', title: undefined, cwd: undefined, running: false, updatedAt: 1_000 },
        { sessionId: 's-new', title: 'Fix the build', cwd: '/srv/a', running: true, updatedAt: 5_000 },
        { sessionId: 's-mid', title: 'Docs', cwd: '/srv/b', running: false, updatedAt: 3_000 },
        { sessionId: 's-none', title: undefined, cwd: undefined, running: false, updatedAt: undefined },
      ],
    })
    const { call } = await mount({}, { 'build-box': state })

    const result = await call('peer_sessions', {})

    expect(text(result)).toBe([
      '4 peer session(s)',
      '- s-new | "Fix the build" | /srv/a | running | 5000ms',
      '- s-mid | "Docs" | /srv/b | idle | 3000ms',
      '- s-old | (untitled) | (no cwd) | idle | 1000ms',
      '- s-none | (untitled) | (no cwd) | idle | unknownms',
    ].join('\n'))
    expect(result.value).toStrictEqual([
      { sessionId: 's-new', running: true, title: 'Fix the build', cwd: '/srv/a', updatedAt: 5_000 },
      { sessionId: 's-mid', running: false, title: 'Docs', cwd: '/srv/b', updatedAt: 3_000 },
      { sessionId: 's-old', running: false, updatedAt: 1_000 },
      { sessionId: 's-none', running: false },
    ])
  })

  it('keeps only the requested number of most recently active sessions', async () => {
    const state = scene({
      sessions: [
        { sessionId: 's-old', title: undefined, cwd: undefined, running: false, updatedAt: 1_000 },
        { sessionId: 's-new', title: undefined, cwd: undefined, running: false, updatedAt: 5_000 },
      ],
    })
    const { call } = await mount({}, { 'build-box': state })

    const result = await call('peer_sessions', { limit: 1, peer: 'build-box' })

    expect(text(result)).toBe('1 peer session(s)\n- s-new | (untitled) | (no cwd) | idle | 5000ms')
    expect(result.value).toStrictEqual([{ sessionId: 's-new', running: false, updatedAt: 5_000 }])
    expect(state.listed).toBe(1)
  })

  it('renders an empty peer registry', async () => {
    const state = scene()
    const { call } = await mount({}, { 'build-box': state })

    const result = await call('peer_sessions', {})

    expect(text(result)).toBe('no peer sessions')
    expect(result.value).toStrictEqual([])
  })

  it('keeps peer order for sessions the peer reported no last activity for', async () => {
    const state = scene({
      sessions: [
        { sessionId: 's-first', title: undefined, cwd: undefined, running: false, updatedAt: undefined },
        { sessionId: 's-second', title: undefined, cwd: undefined, running: false, updatedAt: undefined },
      ],
    })
    const { call } = await mount({}, { 'build-box': state })

    const result = await call('peer_sessions', {})

    expect(text(result)).toBe([
      '2 peer session(s)',
      '- s-first | (untitled) | (no cwd) | idle | unknownms',
      '- s-second | (untitled) | (no cwd) | idle | unknownms',
    ].join('\n'))
    expect(result.value).toStrictEqual([
      { sessionId: 's-first', running: false },
      { sessionId: 's-second', running: false },
    ])
  })
})

describe('peer_transcript', () => {
  it('renders the peer messages oldest first and forwards the session id', async () => {
    const state = scene({ messages: [{ role: 'user', text: 'do it' }, { role: 'assistant', text: 'done' }] })
    const { call } = await mount({}, { 'build-box': state })

    const result = await call('peer_transcript', { session_id: 'session-1', peer: 'build-box' })

    expect(text(result)).toBe('2 peer message(s)\n\n[user] do it\n\n[assistant] done')
    expect(result.value).toStrictEqual([{ role: 'user', text: 'do it' }, { role: 'assistant', text: 'done' }])
    expect(state.transcripts).toEqual([{ sessionId: 'session-1' }])
  })

  it('forwards an explicit tail limit and renders an empty transcript', async () => {
    const populated = scene({ messages: [{ role: 'assistant', text: 'done' }] })
    const empty = scene()
    const { call } = await mount({}, { populated, empty })

    await call('peer_transcript', { session_id: 'session-1', limit: 3, peer: 'populated' })
    expect(populated.transcripts).toEqual([{ sessionId: 'session-1', limit: 3 }])

    const result = await call('peer_transcript', { session_id: 'session-2', peer: 'empty' })
    expect(text(result)).toBe('no peer messages')
    expect(result.value).toStrictEqual([])
  })
})

describe('peer selection through the tools', () => {
  it('addresses the named peer and resolves an unnamed call to the only peer', async () => {
    const alpha = scene()
    const beta = scene()
    const { call } = await mount({}, { alpha, beta })

    await call('peer_ask', { prompt: 'x', peer: 'beta' })
    expect(alpha.asks).toEqual([])
    expect(beta.asks).toHaveLength(1)

    await call('peer_transcript', { session_id: 'session-1', peer: 'alpha' })
    expect(alpha.transcripts).toHaveLength(1)
    expect(beta.transcripts).toEqual([])
  })

  it('resolves an unnamed call to the only configured peer', async () => {
    const only = scene()
    const { call } = await mount({}, { only })

    await call('peer_sessions', {})

    expect(only.listed).toBe(1)
  })

  it('reports the registry refusal when several peers are configured', async () => {
    const { call } = await mount({}, { alpha: scene(), beta: scene() })

    const result = await call('peer_sessions', {})

    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: multiple peers are configured (alpha, beta); name one')
  })
})

describe('peer tool result bounds', () => {
  const longAnswer: PeerAskResult = {
    sessionId: 'peer-1',
    answer: 'y'.repeat(500),
    stopReason: 'end',
    elapsedMs: 1_000,
    usage: undefined,
  }

  it('truncates a rendered ask result at the configured byte cap', async () => {
    const { call } = await mount({ maxResultBytes: 64 }, { 'build-box': scene({ answer: longAnswer }) })

    const rendered = text(await call('peer_ask', { prompt: 'x' }))

    expect(Buffer.byteLength(rendered)).toBe(64)
    expect(rendered.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(rendered).toContain('y'.repeat(48))
  })

  it('truncates at a UTF-8 boundary without producing a replacement character', async () => {
    const answer: PeerAskResult = { ...longAnswer, answer: '界'.repeat(200) }
    const { call } = await mount({ maxResultBytes: 65 }, { 'build-box': scene({ answer }) })

    const rendered = text(await call('peer_ask', { prompt: 'x' }))

    expect(Buffer.byteLength(rendered)).toBe(64)
    expect(rendered).not.toContain('\uFFFD')
    expect(rendered.endsWith(TRUNCATION_MARKER)).toBe(true)
  })

  it('backs a cut up to the character boundary inside a multi-byte run', async () => {
    const state = scene({ messages: [{ role: 'user', text: `x${'é'.repeat(40)}` }] })
    const { call } = await mount({ maxResultBytes: 64 }, { 'build-box': state })

    const rendered = text(await call('peer_transcript', { session_id: 'peer-1' }))

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(64)
    expect(rendered.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(rendered).not.toContain('\uFFFD')
  })

  it('leaves a result exactly filling the cap untouched and truncates one byte over', async () => {
    // 'x\n\n[end | 1.0s | 12 in / 3 out tokens | <sessionId>]' is 41 bytes plus the session id.
    const answerFor = (sessionId: string): PeerAskResult => ({
      sessionId,
      answer: 'x',
      stopReason: 'end',
      elapsedMs: 1_000,
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: undefined },
    })
    const { call } = await mount({ maxResultBytes: 64 }, {
      exact: scene({ answer: answerFor('p'.repeat(23)) }),
      over: scene({ answer: answerFor('p'.repeat(24)) }),
    })

    const untouched = text(await call('peer_ask', { prompt: 'x', peer: 'exact' }))
    expect(Buffer.byteLength(untouched)).toBe(64)
    expect(untouched.endsWith(TRUNCATION_MARKER)).toBe(false)

    const bounded = text(await call('peer_ask', { prompt: 'x', peer: 'over' }))
    expect(Buffer.byteLength(bounded)).toBe(64)
    expect(bounded.endsWith(TRUNCATION_MARKER)).toBe(true)
  })

  it('bounds every peer tool result at the same cap', async () => {
    const state = scene({
      answer: longAnswer,
      sessions: Array.from({ length: 20 }, (_unused, index) => ({
        sessionId: `s-${index}`,
        title: 't'.repeat(30),
        cwd: '/srv',
        running: false,
        updatedAt: index,
      })),
      messages: Array.from({ length: 20 }, () => ({ role: 'assistant' as const, text: 'z'.repeat(30) })),
    })
    const { call } = await mount({ maxResultBytes: 64 }, { 'build-box': state })

    const calls: [string, unknown][] = [
      ['peer_ask', { prompt: 'x' }],
      ['peer_sessions', {}],
      ['peer_transcript', { session_id: 'session-1' }],
    ]
    for (const [name, args] of calls) {
      const rendered = text(await call(name, args))
      expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(64)
      expect(rendered.endsWith(TRUNCATION_MARKER)).toBe(true)
    }
  })

  it('falls back to the declared default cap when apply receives no configured value', async () => {
    const state = scene({ answer: { ...longAnswer, answer: 'y'.repeat(ToolPeer.DEFAULT_MAX_RESULT_BYTES + 1_000) } })
    const { call } = await mountApplied({ 'build-box': state })

    const rendered = text(await call('peer_ask', { prompt: 'x' }))

    expect(Buffer.byteLength(rendered)).toBe(ToolPeer.DEFAULT_MAX_RESULT_BYTES)
    expect(rendered.endsWith(TRUNCATION_MARKER)).toBe(true)
  })
})
