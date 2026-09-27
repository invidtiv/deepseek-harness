/** Heartbeat authentication and writes retain only one operation while a peer stalls. */
import { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PeerTransport } from '../src/transport.ts'
import { SESSION_FOLLOW_PATH } from '../src/peer-stream.ts'
import { pairedSessionHosts } from './session-peer-host.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

it.each(['write failure', 'client cancellation'] as const)('serializes heartbeat checks and joins a pending pulse on %s', async (ending) => {
  const { destination, token } = await pairedSessionHosts((close) => { closes.push(close) }, {
    sessionStreamHeartbeatMs: 20, sessionStreamIdleTimeoutMs: 1000,
  })
  const sessionId = SessionId(randomUUID())
  await destination.controller.create({ workspaceId: destination.workspace.id, sessionId })
  const checking = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  closes.push(async () => { release.resolve(undefined) })
  // Only interval scheduling is virtual; real fetch, socket and write deadlines remain active.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  // Captured methods are invoked below with their original explicit receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const original = { authenticate: PeerTransport.prototype.authenticate, write: ServerResponse.prototype.write }
  let calls = 0
  vi.spyOn(PeerTransport.prototype, 'authenticate').mockImplementation(async function (this: PeerTransport, request) {
    calls++
    if (calls === 2) { checking.resolve(undefined); await release.promise }
    return original.authenticate.call(this, request)
  })
  const blocked = Promise.withResolvers<ServerResponse>()
  let pulses = 0
  vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args) {
    if (args[0] === ': heartbeat\n\n') { pulses++; blocked.resolve(this); return false }
    return original.write.apply(this, args)
  })
  const abort = new AbortController()
  closes.push(async () => { abort.abort() })
  const response = await fetch(destination.url + SESSION_FOLLOW_PATH, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ environmentId: destination.id, request: { workspaceId: destination.workspace.id, sessionId } }),
    signal: abort.signal,
  })
  const reader = response.body!.getReader()
  closes.push(async () => { await reader.cancel().catch(() => undefined); reader.releaseLock() })
  await reader.read()
  await vi.advanceTimersByTimeAsync(60)
  await checking.promise
  expect(calls).toBe(2)
  release.resolve(undefined)
  const socketResponse = await blocked.promise
  await vi.advanceTimersByTimeAsync(20)
  expect(calls).toBe(3)
  expect(pulses).toBe(1)
  const closed = new Promise<void>((resolve) => { socketResponse.once('close', resolve) })
  if (ending === 'write failure') socketResponse.emit('error', new Error('heartbeat receiver stopped'))
  else abort.abort()
  await closed
  expect(socketResponse.destroyed).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})
