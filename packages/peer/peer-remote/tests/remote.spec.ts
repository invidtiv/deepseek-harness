import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RemotePeerError, RemotePeerTransport } from '@deepseek-ai/dsh-peer-remote'
import type { RemotePeerTransportOptions } from '@deepseek-ai/dsh-peer-remote'

/** One accepted Remote call, as the transport sent it. */
interface PeerCall {
  /** Endpoint suffix after `/api/`. */
  readonly endpoint: string
  /** Reserved argument object the call carried. */
  readonly args: Record<string, unknown>
  /** Raw client-request envelope. */
  readonly envelope: Record<string, unknown>
  /** Cookie header value, or undefined when the request carried none. */
  readonly cookie: string | undefined
}

type PeerReply =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'failure'; readonly code?: string; readonly message?: string }
  | { readonly kind: 'status'; readonly status: number; readonly headers?: Record<string, string> }
  | { readonly kind: 'raw'; readonly status: number; readonly body: string }

interface PeerServer {
  readonly baseUrl: string
  readonly calls: PeerCall[]
  reply(handler: (call: PeerCall) => PeerReply): void
  close(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}

/** A live peer surface on an ephemeral port, owned by the calling test. */
async function startPeerServer(): Promise<PeerServer> {
  const calls: PeerCall[] = []
  let route: (call: PeerCall) => PeerReply = () => ({ kind: 'value', value: {} })

  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = undefined
      }
      const envelope = isRecord(parsed) ? parsed : {}
      const payload = isRecord(envelope.payload) ? envelope.payload : {}
      const call: PeerCall = {
        endpoint: new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/api\//u, ''),
        args: isRecord(payload.args) ? payload.args : {},
        envelope,
        cookie: request.headers.cookie,
      }
      calls.push(call)
      const reply = route(call)
      const rpcId = envelope.rpcId
      switch (reply.kind) {
        case 'value':
          send(response, 200, { type: 'server-response', rpcId, result: { ok: true, value: reply.value } })
          return
        case 'failure':
          send(response, 200, {
            type: 'server-response',
            rpcId,
            result: {
              ok: false,
              ...reply.code === undefined && reply.message === undefined ? {} : {
                error: {
                  ...reply.code === undefined ? {} : { code: reply.code },
                  ...reply.message === undefined ? {} : { message: reply.message },
                },
              },
            },
          })
          return
        case 'status':
          response.writeHead(reply.status, reply.headers ?? {})
          response.end()
          return
        case 'raw':
          send(response, reply.status, reply.body)
      }
    })().catch(() => { response.destroy() })
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    reply(handler) { route = handler },
    async close() {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/** Servers this spec started, closed after every test even on failure. */
const servers: PeerServer[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function peerServer(): Promise<PeerServer> {
  const server = await startPeerServer()
  servers.push(server)
  return server
}

function transportFor(server: PeerServer, overrides: Partial<RemotePeerTransportOptions> = {}): RemotePeerTransport {
  return new RemotePeerTransport({
    peerId: 'build-box',
    baseUrl: server.baseUrl,
    resolveCookie: () => Promise.resolve('dsh_session=abc'),
    defaultCwd: undefined,
    defaultAgentPreset: undefined,
    requestTimeoutMs: 2_000,
    askTimeoutMs: 2_000,
    pollIntervalMs: 1,
    ...overrides,
  })
}

describe('RemotePeerTransport session listing', () => {
  it('maps the fields a caller can act on and drops rows without a session id', async () => {
    const server = await peerServer()
    server.reply(() => ({
      kind: 'value',
      value: {
        items: [
          {
            sessionId: 's1',
            cwd: '/srv/work',
            running: true,
            updatedAt: 1_700_000_000_000,
            projections: { asOfSeq: 7, values: { title: 'Fix the build' } },
          },
          { sessionId: 's2' },
          'not a row',
          { running: true },
        ],
      },
    }))
    const transport = transportFor(server)

    await expect(transport.listSessions()).resolves.toEqual([
      { sessionId: 's1', title: 'Fix the build', cwd: '/srv/work', running: true, updatedAt: 1_700_000_000_000 },
      { sessionId: 's2', title: undefined, cwd: undefined, running: false, updatedAt: undefined },
    ])

    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({
      endpoint: 'session/list',
      cookie: 'dsh_session=abc',
      envelope: { type: 'client-request', method: 'session/list', payload: { args: { _request: {} } } },
    })
    expect(server.calls[0]?.envelope.rpcId).toEqual(expect.any(String))
  })

  it('normalizes a trailing slash in the configured origin', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'value', value: { items: [] } }))
    const transport = transportFor(server, { baseUrl: `${server.baseUrl}/` })

    await expect(transport.listSessions()).resolves.toEqual([])

    expect(transport.id).toBe('build-box')
    expect(server.calls).toHaveLength(1)
  })

  it('retries the session list with the alternative reserved argument', async () => {
    const server = await peerServer()
    server.reply(call => '_request' in call.args
      ? { kind: 'failure', code: 'INVALID_ARGS', message: 'unknown argument _request' }
      : { kind: 'value', value: { items: [{ sessionId: 's1' }] } })
    const transport = transportFor(server)

    await expect(transport.listSessions()).resolves.toEqual([
      { sessionId: 's1', title: undefined, cwd: undefined, running: false, updatedAt: undefined },
    ])

    expect(server.calls.map(call => Object.keys(call.args))).toEqual([['_request'], ['request']])
  })

  it('reports the first reserved-argument failure when neither spelling is accepted', async () => {
    const server = await peerServer()
    server.reply(call => '_request' in call.args
      ? { kind: 'failure', code: 'FIRST', message: 'first spelling rejected' }
      : { kind: 'failure', code: 'SECOND', message: 'second spelling rejected' })
    const transport = transportFor(server)

    await expect(transport.listSessions()).rejects.toThrow('session/list -> FIRST: first spelling rejected')

    expect(server.calls).toHaveLength(2)
  })

  it('rejects a peer payload that is not an items array', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'value', value: { nope: true } }))

    await expect(transportFor(server).listSessions()).rejects.toThrow('session/list did not return an items array')
  })
})

describe('RemotePeerTransport wire failures', () => {
  it.each([401, 403])('refuses an HTTP %i credential response', async (status) => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'status', status }))

    const failure = transportFor(server).listSessions()

    await expect(failure).rejects.toBeInstanceOf(RemotePeerError)
    await expect(failure).rejects.toThrow(`peer "build-box" refused the credential (HTTP ${status})`)
  })

  it('reports any other HTTP failure with its endpoint', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'status', status: 500 }))

    await expect(transportFor(server).listSessions()).rejects.toThrow('peer "build-box" answered HTTP 500 on session/list')
  })

  it('rejects a response outside the Remote envelope', async () => {
    const server = await peerServer()
    server.reply(() => ({
      kind: 'raw',
      status: 200,
      body: JSON.stringify({ type: 'server-response', rpcId: 'someone-elses-rpc', result: { ok: true, value: { items: [] } } }),
    }))
    await expect(transportFor(server).listSessions())
      .rejects.toThrow('peer "build-box" answered session/list outside the Remote envelope')

    server.reply(() => ({ kind: 'raw', status: 200, body: JSON.stringify({ hello: 'world' }) }))
    await expect(transportFor(server).listSessions())
      .rejects.toThrow('peer "build-box" answered session/list outside the Remote envelope')
  })

  it('reports a peer error result with its code and detail', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'failure', code: 'GATEWAY', message: 'peer refused the request' }))

    await expect(transportFor(server).listSessions()).rejects.toThrow('session/list -> GATEWAY: peer refused the request')
  })

  it('reports an error result that carries neither code nor detail', async () => {
    const server = await peerServer()
    server.reply(call => ({
      kind: 'raw',
      status: 200,
      body: JSON.stringify({
        type: 'server-response',
        rpcId: call.envelope.rpcId,
        result: { ok: false },
      }),
    }))

    await expect(transportFor(server).listSessions()).rejects.toThrow('session/list -> unknown: no detail')
  })

  it('does not follow a redirect on a credential-bearing request', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'status', status: 302, headers: { location: 'https://elsewhere.test/api/session/list' } }))

    await expect(transportFor(server).listSessions()).rejects.toThrow('peer "build-box" request session/list failed')

    expect(server.calls.map(call => call.endpoint)).toEqual(['session/list', 'session/list'])
  })

  it('reports a non-Error transport failure by its string form', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'value', value: { items: [] } }))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('socket exploded')

    await expect(transportFor(server).listSessions())
      .rejects.toThrow('peer "build-box" request session/list failed: socket exploded')

    expect(server.calls).toEqual([])
  })
})

describe('RemotePeerTransport ask', () => {
  it('runs a create, prompt, poll turn and extracts the peer outcome', async () => {
    const server = await peerServer()
    let cursor = 3
    let prompted = false
    server.reply((call) => {
      switch (call.endpoint) {
        case 'session/create':
          return { kind: 'value', value: { sessionId: 'peer-1' } }
        case 'session/list':
          return { kind: 'value', value: { items: [{ sessionId: 'peer-1', running: prompted, projections: { asOfSeq: cursor } }] } }
        case 'session/prompt':
          prompted = true
          cursor = 12
          return { kind: 'value', value: {} }
        case 'session/page':
          return {
            kind: 'value',
            value: {
              records: [
                { seq: 3, event: { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale answer' }] } } } },
                { seq: 10, event: { seq: 10, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the peer finished' }] } } } },
                { seq: 11, event: { seq: 11, type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } } } } },
                { seq: 12, event: { seq: 12, type: 'turn/end', data: { reason: { kind: 'end' } } } },
              ],
            },
          }
        default:
          throw new Error(`unrouted endpoint ${call.endpoint}`)
      }
    })
    const transport = transportFor(server)

    const result = await transport.ask({
      prompt: 'build the release',
      cwd: '/srv/build',
      agentPreset: 'standard',
      mode: 'steer',
      timeoutMs: 1_000,
    })

    expect(result).toMatchObject({
      sessionId: 'peer-1',
      answer: 'the peer finished',
      stopReason: 'end',
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
    })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.elapsedMs).toBeLessThan(1_000)

    expect(server.calls.find(call => call.endpoint === 'session/create')?.args)
      .toEqual({ request: { cwd: '/srv/build', agentPreset: 'standard' } })
    expect(server.calls.find(call => call.endpoint === 'session/prompt')?.args).toEqual({
      request: {
        requestId: expect.any(String) as unknown,
        sessionId: 'peer-1',
        mode: 'steer',
        content: [{ type: 'text', text: 'build the release' }],
      },
    })
    expect(server.calls.find(call => call.endpoint === 'session/page')?.args).toEqual({
      request: { address: { kind: 'session', sessionId: 'peer-1' }, throughSeq: 12, maxMessages: 80 },
    })
    expect(server.calls.filter(call => call.endpoint === 'session/list')).toHaveLength(2)
  })

  it('continues a named session without creating one and queues the prompt by default', async () => {
    const server = await peerServer()
    let cursor = 0
    server.reply((call) => {
      switch (call.endpoint) {
        case 'session/list':
          return { kind: 'value', value: { items: [{ sessionId: 'peer-9', projections: { asOfSeq: cursor } }] } }
        case 'session/prompt':
          cursor = 5
          return { kind: 'value', value: {} }
        case 'session/page':
          return { kind: 'value', value: { records: [{ seq: 5, event: { seq: 5, type: 'turn/end', data: { reason: { kind: 'stop' } } } }] } }
        default:
          throw new Error(`unrouted endpoint ${call.endpoint}`)
      }
    })
    const transport = transportFor(server)

    await expect(transport.ask({ sessionId: 'peer-9', prompt: 'continue' })).resolves.toMatchObject({
      sessionId: 'peer-9',
      answer: undefined,
      stopReason: 'stop',
      usage: undefined,
    })

    expect(server.calls.some(call => call.endpoint === 'session/create')).toBe(false)
    expect(server.calls.find(call => call.endpoint === 'session/prompt')?.args).toMatchObject({
      request: { sessionId: 'peer-9', mode: 'queue' },
    })
  })

  it('applies the configured directory and preset to a new session, letting the request win', async () => {
    const server = await peerServer()
    let cursor = 0
    server.reply((call) => {
      switch (call.endpoint) {
        case 'session/create':
          cursor = 0
          return { kind: 'value', value: { sessionId: 'peer-1' } }
        case 'session/list':
          return { kind: 'value', value: { items: [{ sessionId: 'peer-1', projections: { asOfSeq: cursor } }] } }
        case 'session/prompt':
          cursor = 4
          return { kind: 'value', value: {} }
        case 'session/page':
          return { kind: 'value', value: { records: [{ seq: 4, event: { seq: 4, type: 'turn/end', data: { reason: { kind: 'end' } } } }] } }
        default:
          throw new Error(`unrouted endpoint ${call.endpoint}`)
      }
    })

    const configured = transportFor(server, { defaultCwd: '/srv/default', defaultAgentPreset: 'standard' })
    await configured.ask({ prompt: 'x' })
    expect(server.calls.find(call => call.endpoint === 'session/create')?.args)
      .toEqual({ request: { cwd: '/srv/default', agentPreset: 'standard' } })

    server.calls.length = 0
    await configured.ask({ prompt: 'x', cwd: '/srv/other', agentPreset: 'minimal' })
    expect(server.calls.find(call => call.endpoint === 'session/create')?.args)
      .toEqual({ request: { cwd: '/srv/other', agentPreset: 'minimal' } })

    server.calls.length = 0
    await transportFor(server).ask({ prompt: 'x' })
    expect(server.calls.find(call => call.endpoint === 'session/create')?.args).toEqual({ request: {} })
  })

  it('rejects an empty prompt before dialing the peer', async () => {
    const server = await peerServer()

    await expect(transportFor(server).ask({ prompt: '   ' })).rejects.toThrow('peer "build-box" needs non-empty prompt text')

    expect(server.calls).toEqual([])
  })

  it('rejects a session/create answer without a session id', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'value', value: {} }))

    await expect(transportFor(server).ask({ prompt: 'x' }))
      .rejects.toThrow('peer "build-box" answered session/create without a session id')
  })

  it('fails when the peer never ends the turn within the ask bound', async () => {
    const server = await peerServer()
    server.reply(call => call.endpoint === 'session/create'
      ? { kind: 'value', value: { sessionId: 'peer-1' } }
      : { kind: 'value', value: { items: [{ sessionId: 'peer-1', projections: { asOfSeq: 0 } }] } })

    await expect(transportFor(server, { askTimeoutMs: 40 }).ask({ prompt: 'x' }))
      .rejects.toThrow('peer "build-box" session peer-1 produced no turn end within 40ms')
  })

  it('reports token usage only for the fields a usage chunk actually carries', async () => {
    const server = await peerServer()
    let cursor = 0
    let records: unknown[] = []
    server.reply((call) => {
      switch (call.endpoint) {
        case 'session/create':
          cursor = 0
          return { kind: 'value', value: { sessionId: 'peer-1' } }
        case 'session/list':
          return { kind: 'value', value: { items: [{ sessionId: 'peer-1', projections: { asOfSeq: cursor } }] } }
        case 'session/prompt':
          cursor = 9
          return { kind: 'value', value: {} }
        case 'session/page':
          return { kind: 'value', value: { records } }
        default:
          throw new Error(`unrouted endpoint ${call.endpoint}`)
      }
    })
    const transport = transportFor(server)

    records = [
      { seq: 1, event: { seq: 1, type: 'assistant/chunk', data: 'not a record' } },
      { seq: 2, event: { seq: 2, type: 'assistant/chunk', data: {} } },
      { seq: 3, event: { seq: 3, type: 'assistant/chunk', data: { chunk: 'not a chunk' } } },
      { seq: 4, event: { seq: 4, type: 'assistant/chunk', data: { chunk: { type: 'text' } } } },
      { seq: 5, event: { seq: 5, type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: 'not usage' } } } },
      { seq: 6, event: { seq: 6, type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: {} } } } },
      { seq: 7, event: { seq: 7, type: 'assistant/message', data: { content: [{ type: 'text', text: 'no tokens' }] } } },
      { seq: 8, event: { seq: 8, type: 'turn/end', data: { reason: { kind: 'end' } } } },
    ]
    const empty = await transport.ask({ prompt: 'x' })

    expect(empty.answer).toBe('no tokens')
    expect(empty.usage).toStrictEqual({ inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined })

    records = [
      { seq: 1, event: { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { cacheReadTokens: 9 } } } } },
      { seq: 2, event: { seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: 'some tokens' }] } } },
      { seq: 3, event: { seq: 3, type: 'turn/end', data: { reason: { kind: 'end' } } } },
    ]
    const partial = await transport.ask({ prompt: 'x' })

    expect(partial.usage).toStrictEqual({ inputTokens: undefined, outputTokens: undefined, cacheReadTokens: 9 })
  })
})

describe('RemotePeerTransport transcript', () => {
  it('keeps only human-authored user messages and the peer assistant text', async () => {
    const server = await peerServer()
    const records: unknown[] = [
      { seq: 1, event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] } } },
      { seq: 2, event: { seq: 2, type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'injected context' }] } } },
      { seq: 3, event: { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'no source' }] } } },
      { seq: 4, event: { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [] } } },
      {
        seq: 5,
        event: {
          seq: 5,
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'part one' }, { type: 'image' }, { type: 'text', text: 'part two' }] } },
        },
      },
      { seq: 6, event: { seq: 6, type: 'assistant/message', data: { content: [{ type: 'text', text: 'legacy shape' }] } } },
      { seq: 7, event: { type: 'tool/call', data: {} } },
      'not a record',
      { seq: 8, event: { seq: 8, data: {} } },
    ]
    server.reply(call => call.endpoint === 'session/list'
      ? { kind: 'value', value: { items: [{ sessionId: 'peer-1', projections: { asOfSeq: 9 } }] } }
      : { kind: 'value', value: { records } })
    const transport = transportFor(server)

    await expect(transport.transcript({ sessionId: 'peer-1' })).resolves.toEqual([
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'part one\npart two' },
      { role: 'assistant', text: 'legacy shape' },
    ])

    expect(server.calls.find(call => call.endpoint === 'session/page')?.args).toEqual({
      request: { address: { kind: 'session', sessionId: 'peer-1' }, throughSeq: 9, maxMessages: 80 },
    })
  })

  it('keeps the trailing limit and clips each message to the character bound', async () => {
    const server = await peerServer()
    const records = Array.from({ length: 12 }, (_unused, index) => ({
      seq: index + 1,
      event: {
        seq: index + 1,
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: index === 11 ? 'x'.repeat(2_100) : `message-${index + 1}` }] },
      },
    }))
    server.reply(call => call.endpoint === 'session/list'
      ? { kind: 'value', value: { items: [{ sessionId: 'peer-1' }] } }
      : { kind: 'value', value: { records } })
    const transport = transportFor(server)

    const defaultTail = await transport.transcript({ sessionId: 'peer-1' })
    expect(defaultTail).toHaveLength(10)
    expect(defaultTail[9]?.text).toBe(`${'x'.repeat(2_000)}… [100 more chars]`)

    await expect(transport.transcript({ sessionId: 'peer-1', limit: 2, maxChars: 5 })).resolves.toEqual([
      { role: 'assistant', text: 'messa… [5 more chars]' },
      { role: 'assistant', text: 'xxxxx… [2095 more chars]' },
    ])
  })

  it('rejects an empty session id and a session the peer does not list', async () => {
    const server = await peerServer()
    server.reply(() => ({ kind: 'value', value: { items: [] } }))
    const transport = transportFor(server)

    await expect(transport.transcript({ sessionId: '' })).rejects.toThrow('peer "build-box" needs a non-empty session id')
    await expect(transport.transcript({ sessionId: 'missing' })).rejects.toThrow('peer "build-box" has no session missing')
  })

  it('rejects a session page that is not a records array', async () => {
    const server = await peerServer()
    server.reply(call => call.endpoint === 'session/list'
      ? { kind: 'value', value: { items: [{ sessionId: 'peer-1' }] } }
      : { kind: 'value', value: { nope: true } })

    await expect(transportFor(server).transcript({ sessionId: 'peer-1' }))
      .rejects.toThrow('session/page did not return a records array')
  })

  it('accepts a page record that is the event object itself', async () => {
    const server = await peerServer()
    server.reply(call => call.endpoint === 'session/list'
      ? { kind: 'value', value: { items: [{ sessionId: 'peer-1' }] } }
      : {
        kind: 'value',
        value: {
          records: [
            { seq: 1, type: 'assistant/message', data: { content: [{ type: 'text', text: 'flat record' }] } },
            { seq: 2, event: { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'wrapped record' }] } } },
          ],
        },
      })

    await expect(transportFor(server).transcript({ sessionId: 'peer-1' })).resolves.toEqual([
      { role: 'assistant', text: 'flat record' },
      { role: 'user', text: 'wrapped record' },
    ])
  })
})

describe('RemotePeerTransport unusable payloads', () => {
  it('keeps polling until a turn ends and folds events that carry no usable payload', async () => {
    const server = await peerServer()
    let prompted = false
    let pages = 0
    server.reply((call) => {
      switch (call.endpoint) {
        case 'session/list':
          return { kind: 'value', value: { items: [{ sessionId: 'peer-1', projections: { asOfSeq: prompted ? 12 : 3 } }] } }
        case 'session/prompt':
          prompted = true
          return { kind: 'value', value: {} }
        case 'session/page':
          pages += 1
          // The first poll sees events but no turn end, so the loop keeps waiting.
          return pages === 1
            ? { kind: 'value', value: { records: [{ seq: 10, event: { seq: 10, type: 'step/start', data: { turn: 1 } } }] } }
            : {
              kind: 'value',
              value: {
                records: [
                  { seq: 10, event: { seq: 10, type: 'step/start', data: { turn: 1 } } },
                  { seq: 11, event: { seq: 11, type: 'assistant/message', data: 'not a record' } },
                  { seq: 12, event: { seq: 12, type: 'assistant/message', data: { content: 'not a block array' } } },
                  { seq: 13, event: { seq: 13, type: 'turn/end', data: 'not a record' } },
                ],
              },
            }
        default:
          throw new Error(`unrouted endpoint ${call.endpoint}`)
      }
    })

    await expect(transportFor(server).ask({ prompt: 'anything', sessionId: 'peer-1', timeoutMs: 1_000 }))
      .resolves.toMatchObject({ sessionId: 'peer-1', answer: undefined, stopReason: 'unknown' })
    expect(pages).toBeGreaterThanOrEqual(2)
  })

  it('falls back to the log head when the session is absent from the baseline list', async () => {
    const server = await peerServer()
    let listed = 0
    server.reply((call) => {
      switch (call.endpoint) {
        case 'session/create':
          return { kind: 'value', value: { sessionId: 'peer-7' } }
        case 'session/list':
          listed += 1
          return listed === 1
            ? { kind: 'value', value: { items: [] } }
            : { kind: 'value', value: { items: [{ sessionId: 'peer-7', projections: { asOfSeq: 9 } }] } }
        case 'session/prompt':
          return { kind: 'value', value: {} }
        case 'session/page':
          return { kind: 'value', value: { records: [{ seq: 9, event: { seq: 9, type: 'turn/end', data: { reason: { kind: 'completed' } } } }] } }
        default:
          throw new Error(`unrouted endpoint ${call.endpoint}`)
      }
    })

    await expect(transportFor(server).ask({ prompt: 'go', timeoutMs: 1_000 }))
      .resolves.toMatchObject({ sessionId: 'peer-7', stopReason: 'completed' })
  })

  it('rejects a session/create answer that is not a record', async () => {
    const server = await peerServer()
    server.reply(call => call.endpoint === 'session/create'
      ? { kind: 'value', value: 'not a record' }
      : { kind: 'value', value: { items: [] } })

    await expect(transportFor(server).ask({ prompt: 'go' }))
      .rejects.toThrow('answered session/create without a session id')
  })

  it('folds a response whose result is not a record into an unknown failure', async () => {
    const server = await peerServer()
    server.reply(call => ({
      kind: 'raw',
      status: 200,
      body: JSON.stringify({ type: 'server-response', rpcId: call.envelope.rpcId, result: 'not a record' }),
    }))

    await expect(transportFor(server).listSessions())
      .rejects.toThrow('session/list -> unknown: no detail')
  })

  it('skips page records without a payload and assistant messages without text', async () => {
    const server = await peerServer()
    server.reply(call => call.endpoint === 'session/list'
      ? { kind: 'value', value: { items: [{ sessionId: 'peer-1', projections: { asOfSeq: 20 } }] } }
      : {
        kind: 'value',
        value: {
          records: [
            { seq: 1, event: { seq: 1, type: 'user/message', data: 'not a record' } },
            { seq: 2, event: { seq: 2, type: 'user/message', data: { source: { kind: 'user' } } } },
            { seq: 3, event: { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'thinking' }] } } } },
            { seq: 4, event: { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'kept' }] } } } },
          ],
        },
      })

    await expect(transportFor(server).transcript({ sessionId: 'peer-1' }))
      .resolves.toEqual([{ role: 'assistant', text: 'kept' }])
  })
})
