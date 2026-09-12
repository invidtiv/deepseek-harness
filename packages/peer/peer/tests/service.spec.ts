import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PeerService, { PeerError } from '@deepseek-ai/dsh-peer'
import type {
  PeerAskRequest,
  PeerAskResult,
  PeerSessionSummary,
  PeerTranscriptRequest,
  PeerTransport,
} from '@deepseek-ai/dsh-peer'

interface StubTransport extends PeerTransport {
  readonly sessions: PeerSessionSummary[]
  readonly listed: (AbortSignal | undefined)[]
  readonly asks: { request: PeerAskRequest; signal: AbortSignal | undefined }[]
  readonly transcripts: { request: PeerTranscriptRequest; signal: AbortSignal | undefined }[]
}

/** One scripted transport that records how the registry addressed it. */
function stubTransport(id: string): StubTransport {
  const sessions: PeerSessionSummary[] = []
  const listed: (AbortSignal | undefined)[] = []
  const asks: { request: PeerAskRequest; signal: AbortSignal | undefined }[] = []
  const transcripts: { request: PeerTranscriptRequest; signal: AbortSignal | undefined }[] = []
  const answer: PeerAskResult = {
    sessionId: `session-of-${id}`,
    answer: `answer-from-${id}`,
    stopReason: 'end',
    elapsedMs: 1,
    usage: undefined,
  }
  return {
    id,
    sessions,
    listed,
    asks,
    transcripts,
    listSessions(signal) {
      listed.push(signal)
      return Promise.resolve(sessions)
    },
    ask(request, signal) {
      asks.push({ request, signal })
      return Promise.resolve(answer)
    },
    transcript(request, signal) {
      transcripts.push({ request, signal })
      return Promise.resolve([])
    },
  }
}

async function mountService(): Promise<{ ctx: Context; peers: PeerService }> {
  const ctx = new Context()
  await ctx.plugin(PeerService)
  return { ctx, peers: ctx.peers }
}

/** The error a synchronous registry call throws; fails the test when it returns. */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the registry call to throw')
}

describe('peer registry registration', () => {
  it('lists registered peer names in registration order', async () => {
    const { peers } = await mountService()
    peers.register(stubTransport('alpha'))
    peers.register(stubTransport('beta'))
    expect(peers.list()).toEqual(['alpha', 'beta'])

    const detached = peers.list()
    detached.push('injected')
    expect(peers.list()).toEqual(['alpha', 'beta'])
  })

  it('rejects an empty peer id with a plain Error', async () => {
    const { peers } = await mountService()
    const error = thrown(() => peers.register(stubTransport('')))
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PeerError)
    expect((error as Error).message).toBe('peer transport id must be non-empty')
    expect(peers.list()).toEqual([])
  })

  it('rejects a duplicate name with DUPLICATE_PEER and keeps the first transport', async () => {
    const { peers } = await mountService()
    peers.register(stubTransport('alpha'))
    const error = thrown(() => peers.register(stubTransport('alpha')))
    expect(error).toBeInstanceOf(PeerError)
    expect(error).toMatchObject({ code: 'DUPLICATE_PEER' })
    expect((error as Error).message).toBe('a peer named "alpha" is already registered')
    expect(peers.list()).toEqual(['alpha'])
  })

  it('removes exactly the transport its disposer owns', async () => {
    const { peers } = await mountService()
    const disposeAlpha = peers.register(stubTransport('alpha'))
    peers.register(stubTransport('beta'))

    disposeAlpha()

    expect(peers.list()).toEqual(['beta'])
    expect(thrown(() => peers.listSessions('alpha'))).toMatchObject({ code: 'NO_PEER' })
    await expect(peers.listSessions('beta')).resolves.toEqual([])
  })

  it('scopes a registration to its contributing fiber (HMR safety)', async () => {
    const { ctx, peers } = await mountService()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.peers.register(stubTransport('gamma'))
    }, { inject: ['peers'] }))
    expect(peers.list()).toEqual(['gamma'])

    await fiber.dispose()

    expect(peers.list()).toEqual([])
  })

  it('refuses every operation once its own fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(PeerService)
    const peers = ctx.peers
    peers.register(stubTransport('alpha'))

    await fiber.dispose()

    expect(thrown(() => peers.listSessions(undefined))).toMatchObject({ code: 'SERVICE_DISPOSING' })
    expect(thrown(() => peers.ask(undefined, { prompt: 'x' }))).toMatchObject({ code: 'SERVICE_DISPOSING' })
    expect(thrown(() => peers.transcript(undefined, { sessionId: 's1' }))).toMatchObject({ code: 'SERVICE_DISPOSING' })
  })
})

describe('peer selection', () => {
  it('resolves an unnamed operation to the only registered transport', async () => {
    const { peers } = await mountService()
    const alpha = stubTransport('alpha')
    peers.register(alpha)
    const signal = new AbortController().signal

    await expect(peers.listSessions(undefined, signal)).resolves.toEqual([])
    await expect(peers.ask(undefined, { prompt: 'do it' }, signal)).resolves.toMatchObject({ answer: 'answer-from-alpha' })
    await expect(peers.transcript(undefined, { sessionId: 's1' }, signal)).resolves.toEqual([])

    expect(alpha.listed).toEqual([signal])
    expect(alpha.asks).toEqual([{ request: { prompt: 'do it' }, signal }])
    expect(alpha.transcripts).toEqual([{ request: { sessionId: 's1' }, signal }])
  })

  it('fails an unnamed operation with NO_PEER when nothing is registered', async () => {
    const { peers } = await mountService()
    const unnamed = thrown(() => peers.listSessions(undefined))
    expect(unnamed).toBeInstanceOf(PeerError)
    expect(unnamed).toMatchObject({ code: 'NO_PEER' })
    expect((unnamed as Error).message).toBe('no peer Harness is configured')

    const named = thrown(() => peers.listSessions('ghost'))
    expect(named).toBeInstanceOf(PeerError)
    expect(named).toMatchObject({ code: 'NO_PEER' })
    expect((named as Error).message).toBe('no peer named "ghost"; registered: none')
  })

  it('fails an unnamed operation with AMBIGUOUS_PEER and names the candidates', async () => {
    const { peers } = await mountService()
    peers.register(stubTransport('alpha'))
    peers.register(stubTransport('beta'))
    const error = thrown(() => peers.ask(undefined, { prompt: 'x' }))
    expect(error).toBeInstanceOf(PeerError)
    expect(error).toMatchObject({ code: 'AMBIGUOUS_PEER' })
    expect((error as Error).message).toBe('multiple peers are configured (alpha, beta); name one')
  })

  it('fails an unregistered name with NO_PEER instead of falling back', async () => {
    const { peers } = await mountService()
    const alpha = stubTransport('alpha')
    peers.register(alpha)
    const error = thrown(() => peers.transcript('beta', { sessionId: 's1' }))
    expect(error).toBeInstanceOf(PeerError)
    expect(error).toMatchObject({ code: 'NO_PEER' })
    expect((error as Error).message).toBe('no peer named "beta"; registered: alpha')
    expect(alpha.transcripts).toEqual([])
  })

  it('routes a named operation to that transport only', async () => {
    const { peers } = await mountService()
    const alpha = stubTransport('alpha')
    const beta = stubTransport('beta')
    peers.register(alpha)
    peers.register(beta)

    await expect(peers.ask('beta', { prompt: 'x' })).resolves.toMatchObject({ sessionId: 'session-of-beta' })

    expect(alpha.asks).toEqual([])
    expect(beta.asks).toEqual([{ request: { prompt: 'x' }, signal: undefined }])
  })
})
