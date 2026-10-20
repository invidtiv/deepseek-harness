/** Real attachment admission and shared pending-event settlement behind destination grants. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import type { TypertRemoteEventInvocation, TypertRemoteEventOutcome } from '@deepseek-ai/dsh-api-gateway'
import { environmentIdSchema } from '../src/protocol.ts'
import { EnvironmentSessionInteractions } from '../src/session-interactions.ts'
import { EnvironmentSessions } from '../src/session-service.ts'
import { interactionResultSchema } from '../src/interaction-protocol.ts'
import { sessionHost } from './session-host.ts'
import { TerminalInputRoutes } from '../src/terminal-input.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const signal = new AbortController().signal

async function fixture() {
  const host = await sessionHost(async (ctx, root) => {
    await ctx.plugin(Typert)
    await ctx.plugin(Attachments, { dshHome: root })
    await ctx.plugin(Credentials, { path: join(root, 'credentials.yml'), watch: false })
    await ctx.plugin(Connection)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(FileUploads)
    await ctx.plugin(TypertGatewayService)
  })
  closers.push(host.close)
  const peer = environmentIdSchema.parse(randomUUID())
  const grant = { environmentId: peer, url: 'https://peer.example.test', tokenEnv: 'UNUSED', workspaces: ['project'], workspaceManagement: false, sessionAccess: true, teamAccess: false, teamOperate: false, attachmentAccess: true, approvalAccess: true, terminalAccess: false }
  host.config.peers.push(grant)
  const sessions = new EnvironmentSessions(host.ctx, host.id, host.config)
  const sessionId = SessionId(randomUUID())
  const address = { workspaceId: host.workspace.id, sessionId }
  await sessions.run(peer, { ...address, action: 'create' }, signal)
  const interactions = new EnvironmentSessionInteractions(host.ctx, host.id, host.config, new TerminalInputRoutes())
  return { ...host, peer, grant, address, sessions, interactions }
}

it('stores uploads only on the owner and reuses an accepted prompt after receipt retirement', async () => {
  const host = await fixture()
  const uploaded = await host.interactions.run(host.peer, { ...host.address, action: 'upload', name: 'review.txt', data: Buffer.from('destination bytes').toString('base64') }, signal)
  if (uploaded.kind !== 'uploaded') throw new Error('Expected upload receipt')
  const request = { ...host.address, action: 'prompt', requestId: brandString<SessionRequestId>(randomUUID()), text: 'Review this file', attachments: [uploaded.upload.receiptId] } as const
  await host.sessions.run(host.peer, request, signal)
  await expect.poll(async () => host.sessions.run(host.peer, { ...host.address, action: 'read' }, signal)).toMatchObject({ running: false, messages: [{ text: request.text }, { text: 'destination reply' }] })
  await host.sessions.run(host.peer, request, signal)
  await expect(host.sessions.run(host.peer, { ...request, text: 'changed' }, signal)).rejects.toThrow('different content')
  const snapshot = interactionResultSchema.parse(await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal))
  expect(snapshot).toMatchObject({ kind: 'snapshot', attachments: [uploaded.upload.file], capabilities: { attachments: true, approvals: true, terminals: false } })
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'download', attachmentId: uploaded.upload.file.attachmentId }, signal)).toMatchObject({ kind: 'download', data: Buffer.from('destination bytes').toString('base64') })
  const other = SessionId(randomUUID())
  await host.sessions.run(host.peer, { ...host.address, sessionId: other, action: 'create' }, signal)
  await expect(host.interactions.run(host.peer, { ...host.address, sessionId: other, action: 'download', attachmentId: uploaded.upload.file.attachmentId }, signal)).rejects.toThrow()
  host.grant.attachmentAccess = false
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'download', attachmentId: uploaded.upload.file.attachmentId }, signal)).rejects.toThrow('not granted')
  await expect(host.sessions.run(host.peer, request, signal)).rejects.toThrow('not granted')
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)).toMatchObject({ attachments: [], capabilities: { attachments: false } })
})

it('settles the same pending approval once and checks the destination grant on every answer', async () => {
  const host = await fixture()
  const result = Promise.withResolvers<TypertRemoteEventOutcome>()
  const actor = { id: host.address.sessionId }
  const source: TypertRemoteEventInvocation = { event: 'approval/request', request: { agent: actor, toolName: 'write_file', reason: 'operator review', signal }, context: { value: host.ctx, subject: actor, agentId: actor.id }, resolve: result.resolve, reject: result.reject }
  const remove = host.ctx.typertGateway.registerRemoteEvents(active => (async function* () {
    yield source
    if (!active.aborted) await new Promise<void>((resolve) =>{  active.addEventListener('abort', () =>{  resolve() }, { once: true }) })
  })(), { home: host.root })
  closers.push(remove)
  await expect.poll(() => host.ctx.remoteEventAccess.pending(actor.id, ['approval/request']).length).toBe(1)
  const snapshot = await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)
  if (snapshot.kind !== 'snapshot' || !snapshot.pending[0]) throw new Error('Expected pending approval')
  const request = { ...host.address, action: 'approval', id: snapshot.pending[0].id, decision: 'allowed-once' } as const
  host.grant.approvalAccess = false
  await expect(host.interactions.run(host.peer, request, signal)).rejects.toThrow('not granted')
  host.grant.approvalAccess = true
  await expect(host.interactions.run(host.peer, request, signal)).resolves.toMatchObject({ kind: 'acknowledged' })
  await expect(result.promise).resolves.toEqual({ kind: 'result', value: 'allowed-once' })
  await expect(host.interactions.run(host.peer, request, signal)).rejects.toThrow('no longer available')
})

it('admits images as model-visible images and restricts their download to the owning Session', async () => {
  const host = await fixture()
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
  const request = { ...host.address, action: 'prompt', requestId: brandString<SessionRequestId>(randomUUID()), text: 'Inspect the image', images: [{ data, mediaType: 'image/png', name: 'pixel.png' }] } as const
  host.config.maxUploadBytes = 1
  await expect(host.sessions.run(host.peer, request, signal)).rejects.toThrow('byte limit')
  host.config.maxUploadBytes = 1048576
  await host.sessions.run(host.peer, request, signal)
  await expect.poll(async () => host.sessions.run(host.peer, { ...host.address, action: 'read' }, signal)).toMatchObject({ running: false })
  const saved = await host.controller.inspect(host.address.sessionId, signal)
  expect(saved.events.find(event => event.type === 'user/message')?.data).toMatchObject({ content: [{ type: 'text' }, { type: 'image', attachment: { mediaType: 'image/png', name: 'pixel.png' } }] })
  const snapshot = await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)
  if (snapshot.kind !== 'snapshot' || !snapshot.attachments[0]) throw new Error('Expected image attachment')
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'download', attachmentId: snapshot.attachments[0].attachmentId }, signal)).toMatchObject({ data, attachment: { mediaType: 'image/png' } })
  await host.sessions.run(host.peer, request, signal)
  await expect(host.sessions.run(host.peer, { ...request, images: [{ ...request.images[0], name: 'changed.png' }] }, signal)).rejects.toThrow('different content')
})

it('validates pending question IDs and options before settling the shared request', async () => {
  const host = await fixture()
  const result = Promise.withResolvers<TypertRemoteEventOutcome>()
  const actor = { id: host.address.sessionId }
  const questions = [{ id: 'direction', question: 'Choose a direction', options: [{ label: 'Left' }, { label: 'Right' }] }]
  const source: TypertRemoteEventInvocation = { event: 'user-questions/request', request: { agent: actor, questions, signal }, context: { value: host.ctx, subject: actor, agentId: actor.id }, resolve: result.resolve, reject: result.reject }
  const remove = host.ctx.typertGateway.registerRemoteEvents(active => (async function* () {
    yield source
    if (!active.aborted) await new Promise<void>((resolve) =>{  active.addEventListener('abort', () =>{  resolve() }, { once: true }) })
  })(), { home: host.root })
  closers.push(remove)
  await expect.poll(() => host.ctx.remoteEventAccess.pending(actor.id, ['user-questions/request']).length).toBe(1)
  const snapshot = await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)
  if (snapshot.kind !== 'snapshot' || !snapshot.pending[0]) throw new Error('Expected pending question')
  const request = { ...host.address, action: 'answer', id: snapshot.pending[0].id } as const
  for (const answers of [[], [{ id: 'other', selected: ['Left'] }], [{ id: 'direction', selected: ['Unknown'] }], [{ id: 'direction', selected: ['Left', 'Right'] }]]) {
    await expect(host.interactions.run(host.peer, { ...request, answer: { answers } }, signal)).rejects.toThrow('question')
  }
  const answer = { answers: [{ id: 'direction', selected: ['Left'] }] }
  await host.interactions.run(host.peer, { ...request, answer }, signal)
  await expect(result.promise).resolves.toEqual({ kind: 'result', value: answer })
})
