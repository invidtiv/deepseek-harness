/** Real destination Sessions exercise grant isolation, concurrent admission, and committed text synchronization. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { EnvironmentSessions } from '../src/session-service.ts'
import { environmentIdSchema } from '../src/protocol.ts'
import { sessionRequestSchema, sessionResultSchema } from '../src/session-protocol.ts'
import { sessionHost } from './session-host.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close() })
const signal = new AbortController().signal
async function fixture() {
  const host = await sessionHost()
  closers.push(host.close)
  const peer = environmentIdSchema.parse(randomUUID())
  host.config.peers.push({ environmentId: peer, url: 'https://peer.example.test', tokenEnv: 'UNUSED', workspaces: ['project'], workspaceManagement: false, sessionAccess: true, teamAccess: false, teamOperate: false, attachmentAccess: false, approvalAccess: false, terminalAccess: false })
  return { ...host, peer, executor: new EnvironmentSessions(host.ctx, host.id, host.config) }
}

it('creates one destination Session across concurrent retries and synchronizes prompts from either operator', async () => {
  const host = await fixture()
  const { workspaceId } = { workspaceId: host.workspace.id }
  const sessionId = SessionId(randomUUID())
  const create = { action: 'create', workspaceId, sessionId } as const
  expect(await Promise.all([host.executor.run(host.peer, create, signal), host.executor.run(host.id, create, signal)])).toEqual([
    { environmentId: host.id, workspaceId, kind: 'created', sessionId },
    { environmentId: host.id, workspaceId, kind: 'created', sessionId },
  ])
  expect(host.workspace.sessionIds).toEqual([sessionId])
  const request = { action: 'prompt', workspaceId, sessionId, requestId: brandString<SessionRequestId>(randomUUID()), text: 'remote message' } as const
  await Promise.all([host.executor.run(host.peer, request, signal), host.executor.run(host.id, request, signal)])
  await expect.poll(async () => host.executor.run(host.id, { action: 'read', workspaceId, sessionId }, signal)).toMatchObject({ running: false, messages: [{ role: 'user', text: 'remote message' }, { role: 'assistant', text: 'destination reply' }] })
  await host.controller.prompt({ sessionId, requestId: brandString<SessionRequestId>(randomUUID()), mode: 'queue', content: [{ type: 'text', text: 'destination message' }] }, signal)
  await expect.poll(async () => host.executor.run(host.peer, { action: 'read', workspaceId, sessionId }, signal)).toMatchObject({ running: false, messages: [{ text: 'remote message' }, { text: 'destination reply' }, { text: 'destination message' }, { text: 'destination reply' }] })
  const snapshot = await host.executor.run(host.peer, { action: 'read', workspaceId, sessionId }, signal)
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
  await expect(snapshot.messages.map(message => `${message.role}: ${message.text}`).join('\n') + '\n').toMatchFileSnapshot('expected/remote-session-transcript.txt')
  await expect(host.executor.run(host.peer, { ...request, text: 'conflicting retry' }, signal)).rejects.toThrow('different content')
  expect(await host.executor.run(host.peer, { action: 'list', workspaceId }, signal)).toMatchObject({ kind: 'sessions', sessions: [{ sessionId, running: false }] })
  expect(await host.executor.run(host.peer, { action: 'cancel', workspaceId, sessionId }, signal)).toMatchObject({ kind: 'cancelled' })
})

it('rechecks session access and workspace grants and rejects foreign identities', async () => {
  const host = await fixture()
  const workspaceId = host.workspace.id
  const sessionId = SessionId(randomUUID())
  await host.executor.run(host.peer, { action: 'create', workspaceId, sessionId }, signal)
  const otherPath = join(host.root, 'other')
  await mkdir(otherPath)
  const other = await host.ctx.workspaceRegistry.create(otherPath)
  await expect(host.executor.run(host.peer, { action: 'list', workspaceId: other.id }, signal)).rejects.toThrow('outside')
  await expect(host.executor.run(host.peer, { action: 'read', workspaceId, sessionId: SessionId('not-member') }, signal)).rejects.toThrow('belong')
  await expect(host.executor.run(host.peer, { action: 'list', workspaceId: brandString<typeof host.workspace.id>('missing') }, signal)).rejects.toThrow('not available')
  host.config.peers[0]!.sessionAccess = false
  await expect(host.executor.run(host.peer, { action: 'read', workspaceId, sessionId }, signal)).rejects.toThrow('not granted')
  expect(await host.executor.run(host.id, { action: 'read', workspaceId, sessionId }, signal)).toMatchObject({ kind: 'snapshot' })
  host.config.peers[0]!.sessionAccess = true
  host.config.peers[0]!.workspaces = []
  await expect(host.executor.run(host.peer, { action: 'list', workspaceId }, signal)).rejects.toThrow('outside')
  const abort = new AbortController()
  abort.abort(new Error('caller left'))
  await expect(host.executor.run(host.id, { action: 'list', workspaceId }, abort.signal)).rejects.toThrow('caller left')
})

it('bounds complete snapshots and rejects unknown wire fields', async () => {
  const host = await fixture()
  const workspaceId = host.workspace.id
  const sessionId = SessionId(randomUUID())
  await host.executor.run(host.peer, { action: 'create', workspaceId, sessionId }, signal)
  host.config.maxBytes = 1
  await expect(host.executor.run(host.peer, { action: 'read', workspaceId, sessionId }, signal)).rejects.toThrow('byte limit')
  expect(sessionRequestSchema.safeParse({ action: 'prompt', workspaceId, sessionId, requestId: 'retry', text: ' ' }).success).toBe(false)
  expect(sessionRequestSchema.safeParse({ action: 'create', workspaceId, sessionId, cwd: '/caller' }).success).toBe(false)
  expect(sessionResultSchema.safeParse({ environmentId: host.id, workspaceId, kind: 'snapshot', sessionId, cursor: -1, running: false, messages: [], truncated: false, secret: 'not allowed' }).success).toBe(false)
})

it('reads bounded saved text without activating an Agent and leaves replacement context out of human history', async () => {
  const host = await fixture()
  const sessionId = SessionId(randomUUID())
  const session = host.ctx.sessions.create(sessionId, { meta: { cwd: host.cwd } })
  const first = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '' }] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'model context' }] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'model replacement' }] }), { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq] })
  await host.workspace.attachSession(sessionId)
  host.config.sessionPageSize = 1
  const request = { action: 'read', workspaceId: host.workspace.id, sessionId } as const
  expect(await host.executor.run(host.peer, request, signal)).toMatchObject({ running: false, messages: [{ text: 'second' }], truncated: true })
  expect(host.ctx.agents.get(sessionId)).toBeUndefined()
  const requestId = brandString<SessionRequestId>('saved-cold-request')
  session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'already accepted' }] }), { surfaceOp: 'append' })
  await expect(host.executor.run(host.peer, { action: 'prompt', workspaceId: host.workspace.id, sessionId, requestId, text: 'changed after reconnect' }, signal)).rejects.toThrow('different content')
  expect(host.ctx.agents.get(sessionId)).toBeUndefined()
  const listed = await host.controller.list({}, signal)
  vi.spyOn(host.controller, 'list').mockResolvedValue({ items: listed.items.map(item => ({ ...item, projections: { kind: 'sequenced', asOfSeq: 0, values: { title: 'Destination title' } } })) })
  expect(await host.executor.run(host.peer, { action: 'list', workspaceId: host.workspace.id }, signal)).toMatchObject({ sessions: [{ title: 'Destination title' }] })
})

it('lets an authorized queued retry proceed after an earlier operation rejects', async () => {
  const host = await fixture()
  const sessionId = SessionId(randomUUID())
  const failed = host.executor.run(host.peer, { action: 'create', workspaceId: brandString<typeof host.workspace.id>('missing'), sessionId }, signal)
  const succeeded = host.executor.run(host.peer, { action: 'create', workspaceId: host.workspace.id, sessionId }, signal)
  await expect(failed).rejects.toThrow('not available')
  await expect(succeeded).resolves.toMatchObject({ kind: 'created', sessionId })
})

it('rejects subagent reads and control before admission and reports unavailable session services', async () => {
  const host = await fixture()
  const sessionId = SessionId(randomUUID())
  host.ctx.sessions.create(sessionId, { meta: { cwd: host.cwd, origin: 'subagent' } })
  await host.workspace.attachSession(sessionId)
  for (const action of ['read', 'cancel'] as const) {
    await expect(host.executor.run(host.peer, { action, workspaceId: host.workspace.id, sessionId }, signal)).rejects.toThrow('does not belong')
  }
  await expect(host.executor.run(host.peer, { action: 'prompt', workspaceId: host.workspace.id, sessionId, requestId: brandString<SessionRequestId>('subagent-retry'), text: 'do not admit' }, signal)).rejects.toThrow('does not belong')
  const ctx = new Context()
  closers.push(() => ctx.fiber.dispose())
  await expect(new EnvironmentSessions(ctx, host.id, host.config).run(host.id, { action: 'list', workspaceId: host.workspace.id }, signal)).rejects.toThrow('unavailable')
})
