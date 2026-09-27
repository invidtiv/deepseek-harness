/** Authenticated HTTP clients share destination-owned Sessions without caller-side copies. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { pairedSessionHosts } from './session-peer-host.ts'
import { PeerTransport, PEER_PATH } from '../src/transport.ts'
import { sessionRequestSchema, sessionResultSchema } from '../src/session-protocol.ts'
import { EnvironmentSessions } from '../src/session-service.ts'
import type { SessionRequest } from '../src/session-types.ts'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })

it('creates remotely and converges two clients on one persisted prompt after a concurrent retry', async () => {
  const { caller, destination, token } = await pairedSessionHosts((close) => { closes.push(close) })
  const signal = new AbortController().signal
  const first = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  const second = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  const send = async (transport: PeerTransport, request: SessionRequest) => sessionResultSchema.parse(JSON.parse(await transport.call(destination.id, { kind: 'session', environmentId: destination.id, request }, signal)))
  const create = sessionRequestSchema.parse({ action: 'create', workspaceId: destination.workspace.id, sessionId: `session-${randomUUID()}` })
  const created = await send(first, create)
  expect(created.kind).toBe('created')
  if (!('sessionId' in created)) throw new Error('missing created Session')
  expect(caller.ctx.sessions.get(created.sessionId)).toBeUndefined()
  expect(destination.workspace.sessionIds).toContain(created.sessionId)
  const prompt = sessionRequestSchema.parse({ action: 'prompt', workspaceId: destination.workspace.id, sessionId: created.sessionId, requestId: randomUUID(), text: 'message from another machine' })
  const local = new EnvironmentSessions(destination.ctx, destination.id, destination.config)
  expect(await Promise.all([send(first, prompt), send(second, prompt), local.run(destination.id, prompt, signal)])).toEqual([
    { kind: 'accepted', environmentId: destination.id, workspaceId: destination.workspace.id, sessionId: created.sessionId },
    { kind: 'accepted', environmentId: destination.id, workspaceId: destination.workspace.id, sessionId: created.sessionId },
    { kind: 'accepted', environmentId: destination.id, workspaceId: destination.workspace.id, sessionId: created.sessionId },
  ])
  const read = sessionRequestSchema.parse({ action: 'read', workspaceId: destination.workspace.id, sessionId: created.sessionId })
  await vi.waitFor(async () => {
    const view = await send(first, read)
    expect(view).toMatchObject({ kind: 'snapshot', running: false, messages: [{ role: 'user', text: 'message from another machine' }, { role: 'assistant', text: 'destination reply' }] })
  }, { timeout: 5000 })
  expect(await send(second, read)).toEqual(await local.run(destination.id, read, signal))
  const inspected = await destination.controller.inspect(created.sessionId)
  expect(inspected.events.filter(event => event.type === 'user/message')).toHaveLength(1)
  const browser = await fetch(`${destination.url}${PEER_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: caller.url, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'session', environmentId: destination.id, request: read }) })
  expect(browser.status).toBe(401)
  await browser.body?.cancel()
})

it('aborts the destination read when its authenticated HTTP client disconnects', async () => {
  const { caller, destination } = await pairedSessionHosts((close) => { closes.push(close) })
  let started!: () => void
  let cancelled!: () => void
  const reading = new Promise<void>((resolve) => { started = resolve })
  const stopped = new Promise<void>((resolve) => { cancelled = resolve })
  vi.spyOn(SessionController.prototype, 'list').mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(new Error('destination read cancelled')) }, { once: true })
    started()
  }))
  const abort = new AbortController()
  const transport = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  const pending = transport.call(destination.id, { kind: 'session', environmentId: destination.id, request: { action: 'list', workspaceId: destination.workspace.id } }, abort.signal)
  const rejected = expect(pending).rejects.toThrow()
  await reading
  abort.abort()
  await rejected
  await stopped
})
