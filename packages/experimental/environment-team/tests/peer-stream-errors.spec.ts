/** Real ephemeral HTTP peers exercise authentication, framing, deadlines and status classification. */
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { PeerTransport, DESCRIPTOR_PATH } from '../src/transport.ts'
import { SESSION_FOLLOW_PATH } from '../src/peer-stream.ts'
import { environmentIdSchema } from '../src/protocol.ts'
import { resolveConfig } from '../src/config.ts'
import { pairedSessionHosts } from './session-peer-host.ts'
import { EnvironmentTeams } from '../src/runtime.ts'
import type { EnvironmentSessionFollowRequest } from '../src/session-types.ts'

const closes: (() => Promise<void>)[] = []
const aborts: AbortController[] = []
afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort()
  vi.restoreAllMocks()
  for (const close of closes.splice(0).reverse()) await close()
})

async function peer() {
  const local = environmentIdSchema.parse(randomUUID())
  const remote = environmentIdSchema.parse(randomUUID())
  let descriptorId = remote
  let serve = (response: ServerResponse) => { response.writeHead(503).end() }
  const server = createServer((request, response) => {
    if (request.url === DESCRIPTOR_PATH) response.end(JSON.stringify({ environmentId: descriptorId, label: 'test', platform: 'linux', protocol: 1, capabilities: { distributedTeams: true, workspaceSessionFollow: true } }))
    else serve(response)
  })
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture port unavailable')
  const config = resolveConfig({ stateDirectory: process.cwd(), label: 'test', provider: 'mock', model: 'mock', agentPreset: 'test', sandboxMode: 'read-only', approvalPolicy: 'ask', workspaces: {}, maxBytes: 1024, peers: [{ environmentId: remote, url: `http://127.0.0.1:${address.port}`, tokenEnv: 'PAIR', workspaces: [] }] })
  const transport = new PeerTransport(local, config, { resolve: async () => ({ value: 'x'.repeat(32), source: 'test' }) })
  const request = { workspaceId: brandString<EnvironmentSessionFollowRequest['workspaceId']>('workspace'), sessionId: SessionId('session') }
  const follow = () => {
    const abort = new AbortController()
    aborts.push(abort)
    return { abort, iterator: transport.follow(remote, request, abort.signal)[Symbol.asyncIterator]() }
  }
  return {
    config, transport, request, local, remote, follow,
    serve: (handler: (response: ServerResponse) => void) => { serve = handler },
    descriptor: (id: typeof remote) => { descriptorId = id },
  }
}

it('maps HTTP failures and refuses invalid or empty response streams', async () => {
  const host = await peer()
  for (const [status, code] of [[401, 'denied'], [403, 'denied'], [404, 'unsupported'], [422, 'protocol'], [503, 'unavailable']] as const) {
    host.serve((response) => { response.writeHead(status).end() })
    await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: `environment/session-${code}` })
  }
  for (const status of [200, 204]) {
    host.serve((response) => { response.writeHead(status, { 'content-type': 'application/json' }).end('{}') })
    await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  }
  host.serve((response) => { response.writeHead(200).end('{}') })
  await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  host.serve((response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }).end() })
  await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
})

it('rejects incomplete SSE framing, multibyte frame overflow, oversized requests and wrong discovery identity', async () => {
  const host = await peer()
  host.serve((response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('retry: invalid\n\n') })
  await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  host.serve((response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ text: '🦈'.repeat(300) })}\n\n`) })
  await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  await expect(host.transport.follow(host.remote, { ...host.request, sessionId: SessionId('x'.repeat(2048)) }, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  host.descriptor(host.local)
  await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
  host.config.peers = []
  await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-denied' })
})

it('ends caller-cancelled reads and bounds an idle authenticated connection', async () => {
  const host = await peer()
  const initial = host.follow()
  initial.abort.abort()
  expect(await initial.iterator.next()).toMatchObject({ done: true })
  const entered = Promise.withResolvers<undefined>()
  host.serve((response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); entered.resolve(undefined) })
  const waiting = host.follow()
  const pending = waiting.iterator.next()
  await entered.promise
  waiting.abort.abort()
  expect(await pending).toMatchObject({ done: true })
  host.config.sessionStreamIdleTimeoutMs = 25
  host.config.sessionStreamHeartbeatMs = 5
  await expect(host.follow().iterator.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
})

it('rejects unauthenticated, wrong-method, malformed and oversized incoming requests before Session access', async () => {
  const { caller, destination, token } = await pairedSessionHosts((close) => { closes.push(close) }, { maxBytes: 1024 })
  const url = destination.url + SESSION_FOLLOW_PATH
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const request = { environmentId: destination.id, request: { workspaceId: destination.workspace.id, sessionId: 'missing' } }
  const cases: [RequestInit, number][] = [
    [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 401],
    [{ method: 'GET', headers }, 415],
    [{ method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' }, 415],
    [{ method: 'POST', headers, body: '{}' }, 400],
    [{ method: 'POST', headers, body: 'malformed JSON' }, 400],
    [{ method: 'POST', headers, body: JSON.stringify({ ...request, environmentId: caller.id }) }, 409],
    [{ method: 'POST', headers, body: 'x'.repeat(2048) }, 413],
    [{ method: 'POST', headers, body: JSON.stringify(request) }, 403],
  ]
  for (const [options, expected] of cases) {
    const response = await fetch(url, options)
    expect(response.status).toBe(expected)
    await response.body?.cancel()
  }
  vi.spyOn(destination.ctx.credentials, 'resolve').mockRejectedValueOnce(new Error('credential unavailable'))
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) })
  expect(response.status).toBe(401)
  await response.body?.cancel()
  for (const [code, status] of [['environment/session-denied', 403], ['environment/session-unsupported', 404], ['environment/session-protocol', 422], ['environment/session-unavailable', 503]] as const) {
    vi.spyOn(EnvironmentTeams.prototype, 'follow').mockImplementationOnce(() => { throw new RemoteError(code, 'fixture source failed', {}) })
    const rejected = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) })
    expect(rejected.status).toBe(status)
    await rejected.body?.cancel()
  }
})
