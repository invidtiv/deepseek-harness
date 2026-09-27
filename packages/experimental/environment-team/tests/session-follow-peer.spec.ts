/** Real HTTP stream identity, cancellation, reconnect, and transient-to-durable delivery. */
import { randomUUID } from 'node:crypto'
import { createServer, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PeerTransport, DESCRIPTOR_PATH } from '../src/transport.ts'
import { SESSION_FOLLOW_PATH } from '../src/peer-stream.ts'
import { EnvironmentSessions } from '../src/session-service.ts'
import type { EnvironmentSessionFrame } from '../src/session-types.ts'
import { pairedSessionHosts } from './session-peer-host.ts'

const closes: (() => Promise<void>)[] = []
const aborts: AbortController[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort()
  for (const release of releases.splice(0)) release()
  vi.restoreAllMocks()
  for (const close of closes.splice(0).reverse()) await close()
})

async function fixture(overrides = {}) {
  const pair = await pairedSessionHosts((close) => { closes.push(close) }, overrides)
  const sessionId = SessionId(randomUUID())
  await pair.destination.controller.create({ workspaceId: pair.destination.workspace.id, sessionId })
  const request = { workspaceId: pair.destination.workspace.id, sessionId }
  const transport = new PeerTransport(pair.caller.id, pair.caller.config, pair.caller.ctx.credentials)
  const follow = () => {
    const abort = new AbortController()
    aborts.push(abort)
    return { abort, iterator: transport.follow(pair.destination.id, request, abort.signal)[Symbol.asyncIterator]() }
  }
  return { ...pair, request, transport, follow }
}

async function until(
  iterator: AsyncIterator<EnvironmentSessionFrame>, accept: (frame: EnvironmentSessionFrame) => boolean,
): Promise<EnvironmentSessionFrame> {
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new Error('Session stream ended before the expected frame')
    if (accept(next.value)) return next.value
  }
}

it('streams live model text, leaves the Agent running on disconnect, and catches up without duplicate messages', async () => {
  const { destination, request, follow } = await fixture()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  releases.push(release)
  vi.spyOn(destination.adapter, 'stream').mockImplementation(async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Live prefix' }
    await blocked
    yield { type: 'text-delta', index: 0, text: ' completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Live prefix completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const first = follow()
  expect((await first.iterator.next()).value).toMatchObject({ environmentId: destination.id, sessionId: request.sessionId, messages: [] })
  await destination.controller.prompt({ sessionId: request.sessionId, requestId: brandString<SessionRequestId>(randomUUID()), content: [{ type: 'text', text: 'Start streaming' }], mode: 'queue' }, first.abort.signal)
  const live = await until(first.iterator, frame => frame.live?.text === 'Live prefix')
  expect(live.messages.filter(message => message.role === 'assistant')).toHaveLength(0)
  first.abort.abort()
  await first.iterator.return?.()
  expect(destination.ctx.agents.get(request.sessionId)?.status).toBe('running')
  const second = follow()
  expect((await second.iterator.next()).value).toMatchObject({ live: { text: 'Live prefix' } })
  release()
  const committed = await until(second.iterator, frame => !frame.live && frame.messages.some(message => message.text === 'Live prefix completed'))
  expect(committed.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
  second.abort.abort()
  await second.iterator.return?.()
  const third = follow()
  const caughtUp = await third.iterator.next()
  if (caughtUp.done) throw new Error('Missing reconnected snapshot')
  expect(caughtUp.value.messages).toEqual(committed.messages)
  third.abort.abort()
  await third.iterator.return?.()
})

it('rechecks pair credentials during heartbeats and rejects browser-origin and wrong-destination requests', async () => {
  const { caller, destination, request, token, follow } = await fixture({ sessionStreamHeartbeatMs: 10, sessionStreamIdleTimeoutMs: 1000 })
  const opened = follow()
  await opened.iterator.next()
  const ending = expect(opened.iterator.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
  await destination.ctx.credentials.set(credentialRef('SESSION_PAIR'), randomUUID() + randomUUID())
  await ending
  const origin = await fetch(destination.url + SESSION_FOLLOW_PATH, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: caller.url, 'content-type': 'application/json' }, body: JSON.stringify({ environmentId: destination.id, request }) })
  expect(origin.status).toBe(401)
  await origin.body?.cancel()
  const renewed = randomUUID() + randomUUID()
  await destination.ctx.credentials.set(credentialRef('SESSION_PAIR'), renewed)
  const mismatch = await fetch(destination.url + SESSION_FOLLOW_PATH, { method: 'POST', headers: { authorization: `Bearer ${renewed}`, 'content-type': 'application/json' }, body: JSON.stringify({ environmentId: caller.id, request }) })
  expect(mismatch.status).toBe(409)
  await mismatch.body?.cancel()
})

it('rejects mismatched, malformed and oversized peer frames before publishing them', async () => {
  const { destination, caller, request, follow } = await fixture({ maxBytes: 1024 })
  const cases = [
    { kind: 'snapshot', environmentId: caller.id, ...request, cursor: -1, running: false, messages: [], truncated: false },
    { kind: 'snapshot', environmentId: destination.id, ...request, workspaceId: 'another', cursor: -1, running: false, messages: [], truncated: false },
    { kind: 'snapshot', environmentId: destination.id, ...request, sessionId: 'another', cursor: -1, running: false, messages: [], truncated: false },
    { invalid: true },
    { oversized: 'x'.repeat(2048) },
  ]
  let body = ''
  let supported = true
  const server = createServer((request, response) => {
    if (request.url === DESCRIPTOR_PATH) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ environmentId: destination.id, label: 'fixture', platform: 'linux', protocol: 1, capabilities: { distributedTeams: true, workspaceSessionFollow: supported ? true : undefined } }))
    } else { response.setHeader('content-type', 'text/event-stream'); response.end(body) }
  })
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture port')
  caller.config.peers[0]!.url = `http://127.0.0.1:${address.port}`
  for (const frame of cases) {
    body = `data: ${JSON.stringify(frame)}\n\n`
    await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  }
  body = 'event: error\ndata: {"code":"environment/session-denied"}\n\n'
  await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-denied' })
  body = 'event: error\ndata: {"code":"arbitrary"}\n\n'
  await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  body = 'event: arbitrary\ndata: {}\n\n'
  await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  body = 'event: error\ndata: not JSON\n\n'
  await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  supported = false
  await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-unsupported' })
})


it('reports a late oversized destination snapshot as a terminal protocol error', async () => {
  const { destination, request, follow } = await fixture({ maxBytes: 1024 })
  const opened = follow()
  await opened.iterator.next()
  const session = destination.ctx.sessions.get(request.sessionId)
  if (!session) throw new Error('Missing destination Session')
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(2048) }],
  }), { surfaceOp: 'append' })
  await expect(opened.iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
})

it.each(['plain', 'remote', 'write-failure'] as const)('reports a stopped source with %s failure', async (kind) => {
  const { follow } = await fixture()
  vi.spyOn(EnvironmentSessions.prototype, 'follow').mockImplementation(async function* () { /* Empty destination generation. */ })
  await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
  vi.restoreAllMocks()
  const original = Object.getOwnPropertyDescriptor(EnvironmentSessions.prototype, 'follow')?.value as EnvironmentSessions['follow']
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  vi.spyOn(EnvironmentSessions.prototype, 'follow').mockImplementation(function (this: EnvironmentSessions, peer, request, signal) {
    const source = original.call(this, peer, request, signal)
    return (async function* () {
      for await (const frame of source) {
        yield frame
        await release.promise
        if (kind === 'remote') throw new RemoteError('gateway/internal', 'fixture internal failure', {})
        throw new Error('fixture destination failure')
      }
    })()
  })
  const opened = follow()
  await opened.iterator.next()
  if (kind === 'write-failure') {
    // The original method is always invoked with its response receiver below.
    // oxlint-disable-next-line typescript/unbound-method
    const originalWrite = ServerResponse.prototype.write
    vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args) {
      if (typeof args[0] === 'string' && args[0].startsWith('event: error')) throw new Error('fixture terminal write failure')
      return originalWrite.apply(this, args)
    })
  }
  release.resolve(undefined)
  await expect(opened.iterator.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
})


it('includes SSE framing in the destination response limit before sending headers', async () => {
  const { follow } = await fixture({ maxBytes: 1024 })
  const opened = follow()
  const first = await opened.iterator.next()
  if (first.done) throw new Error('Missing opening snapshot')
  opened.abort.abort()
  await opened.iterator.return?.()
  const message = { seq: 1, role: 'user' as const, text: '' }
  const frame = { ...first.value, messages: [message] }
  message.text = 'x'.repeat(1024 - Buffer.byteLength(JSON.stringify(frame)))
  vi.spyOn(EnvironmentSessions.prototype, 'follow').mockImplementation(async function* () { yield frame })
  await expect(follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
})
