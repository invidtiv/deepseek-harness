/** Real socket pressure bounds stalled writers and preserves normal large snapshots. */
import { ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pairedSessionHosts } from './session-peer-host.ts'
import { PeerTransport } from '../src/transport.ts'
import { SESSION_FOLLOW_PATH } from '../src/peer-stream.ts'
import { EnvironmentSessions } from '../src/session-service.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(size: number) {
  const pair = await pairedSessionHosts((close) => { closes.push(close) }, {
    maxBytes: 16 * 1024 * 1024, requestTimeoutMs: 1000, sessionStreamHeartbeatMs: 100, sessionStreamIdleTimeoutMs: 3000,
  })
  const sessionId = SessionId(randomUUID())
  const session = pair.destination.ctx.sessions.create(sessionId, { meta: { cwd: pair.destination.cwd } })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(size) }] }), { surfaceOp: 'append' })
  await pair.destination.workspace.attachSession(sessionId)
  return { ...pair, request: { workspaceId: pair.destination.workspace.id, sessionId } }
}

it('drains a bounded large frame through the real HTTP response before closing its follower', async () => {
  const { caller, destination, request } = await fixture(200_000)
  const abort = new AbortController()
  closes.push(async () => { abort.abort() })
  const transport = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  const iterator = transport.follow(destination.id, request, abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new Error('Missing opening snapshot')
  expect(first.value.messages[0]?.text).toHaveLength(200_000)
  abort.abort()
  await iterator.return?.()
})

it.each(['disconnect', 'deadline', 'error', 'close-during-write'] as const)('joins a stalled writer on %s without relying on host socket buffer sizes', async (cause) => {
  const { destination, request, token } = await fixture(200_000)
  let block!: (response: ServerResponse) => void
  const blocked = new Promise<ServerResponse>((resolve) => { block = resolve })
  // Captured methods retain their explicit receivers through apply/call below.
  // oxlint-disable-next-line typescript/unbound-method
  const original = { write: ServerResponse.prototype.write, follow: EnvironmentSessions.prototype.follow }
  vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args) {
    if (this.getHeader('content-type') === 'text/event-stream' && typeof args[0] === 'string' && args[0].length > 100_000) {
      this.flushHeaders()
      block(this)
      if (cause === 'close-during-write') this.emit('close')
      return false
    }
    return original.write.apply(this, args)
  })
  let stopped!: () => void
  const closed = new Promise<void>((resolve) => { stopped = resolve })
  vi.spyOn(EnvironmentSessions.prototype, 'follow').mockImplementation(function (this: EnvironmentSessions, peer, input, signal) {
    const source = original.follow.call(this, peer, input, signal)
    return (async function* () { try { yield* source } finally { stopped() } })()
  })
  const origin = new URL(destination.url)
  const socket = createConnection({ host: origin.hostname, port: Number(origin.port) })
  closes.push(async () => { socket.destroy() })
  socket.on('error', (_closedSocket) => { /* The test intentionally disconnects the receiver. */ })
  socket.pause()
  const body = JSON.stringify({ environmentId: destination.id, request })
  socket.write(`POST ${SESSION_FOLLOW_PATH} HTTP/1.1\r\nHost: ${origin.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  const response = await blocked
  if (cause === 'disconnect') socket.destroy()
  if (cause === 'error') response.emit('error', new Error('fixture write failure'))
  await closed
  expect(response.destroyed || response.writableEnded).toBe(true)
}, 15000)
