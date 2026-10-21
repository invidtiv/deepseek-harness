/** Destination grants, limits and unavailable services around Session interactions and terminals. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { TerminalController, type Config as TerminalConfig } from '@deepseek-ai/dsh-api-terminal-controller'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TerminalAttachmentId, TerminalFrame, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import type { TypertRemoteEventInvocation, TypertRemoteEventOutcome } from '@deepseek-ai/dsh-api-gateway'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { environmentIdSchema } from '../src/protocol.ts'
import { interactionRequestSchema } from '../src/interaction-protocol.ts'
import { EnvironmentSessionInteractions } from '../src/session-interactions.ts'
import { EnvironmentSessions } from '../src/session-service.ts'
import type { EnvironmentInteractionRequest, EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from '../src/interaction-types.ts'
import type { SessionRequest } from '../src/session-types.ts'
import { sessionHost } from './session-host.ts'

type PromptRequest = Extract<SessionRequest, { action: 'prompt' }>

const closers: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close() })
const signal = new AbortController().signal

const terminalConfig: TerminalConfig = { shellCandidates: ['sh'], shell: undefined, maxTerminals: 2, maxCols: 200, maxRows: 100, scrollback: 100, maxBufferedBytes: 100_000, maxInputBytes: 1000, disposeGraceMs: 100, unattendedTimeoutMs: 7_200_000, activityPollIntervalMs: 30_000, cleanupRetryMs: 60_000 }

async function fixture() {
  const host = await sessionHost(async (ctx, root) => {
    await ctx.plugin(Typert)
    await ctx.plugin(Attachments, { dshHome: root })
    await ctx.plugin(Credentials, { path: join(root, 'credentials.yml'), watch: false })
    await ctx.plugin(Connection)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(FileUploads)
    await ctx.plugin(TypertGatewayService)
    new TerminalController(ctx, terminalConfig)
  })
  closers.push(host.close)
  const peer = environmentIdSchema.parse(randomUUID())
  const grant = { environmentId: peer, url: 'https://peer.example.test', tokenEnv: 'UNUSED', workspaces: ['project'], workspaceManagement: false, sessionAccess: true, teamAccess: false, teamOperate: false, attachmentAccess: true, approvalAccess: true, terminalAccess: true }
  host.config.peers.push(grant)
  const sessions = new EnvironmentSessions(host.ctx, host.id, host.config)
  const sessionId = SessionId(randomUUID())
  const address = { workspaceId: host.workspace.id, sessionId }
  await sessions.run(peer, { ...address, action: 'create' }, signal)
  return { ...host, peer, grant, address, sessions, interactions: new EnvironmentSessionInteractions(host.ctx, host.id, host.config) }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function finishTurn(host: Fixture) {
  await expect.poll(async () => host.sessions.run(host.peer, { ...host.address, action: 'read' }, signal)).toMatchObject({ running: false })
}

async function prompt(host: Fixture, content: Pick<PromptRequest, 'text' | 'images'>) {
  await host.sessions.run(host.peer, { ...host.address, action: 'prompt', requestId: brandString<SessionRequestId>(randomUUID()), ...content }, signal)
  await finishTurn(host)
}

/** Publishes one pending remote event until the fixture closes. */
async function publish(host: Fixture, source: TypertRemoteEventInvocation, event: 'approval/request' | 'user-questions/request') {
  const remove = host.ctx.typertGateway.registerRemoteEvents(active => (async function* () {
    yield source
    if (!active.aborted) await new Promise<void>((resolve) => { active.addEventListener('abort', () => { resolve() }, { once: true }) })
  })(), { home: host.root })
  closers.push(remove)
  await expect.poll(() => host.ctx.remoteEventAccess.pending(host.address.sessionId, [event]).length).toBe(1)
}

function terminalInfo(id: WebTerminalId, cwd: string): WebTerminalInfo {
  return { id, title: 'Shell', shell: { path: '/fixture/shell', args: [], name: 'Fixture shell' }, cwd, cols: 80, rows: 24, state: 'running', exitCode: null }
}

/** Replaces the Agent argument of recorded terminal controller calls with its Session identity. */
const owners = (calls: readonly (readonly [{ id: SessionId }, ...unknown[]])[]) => calls.map(([agent, ...rest]) => [agent.id, ...rest])
const terminalId = brandString<WebTerminalId>('terminal')
const attachmentId = brandString<TerminalAttachmentId>('viewer')

it('withholds pending interactions and terminals from a snapshot when their grants are absent', async () => {
  const host = await fixture()
  host.grant.approvalAccess = false
  host.grant.terminalAccess = false
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)).toMatchObject({ pending: [], terminals: [], capabilities: { approvals: false, terminals: false } })
})

it('bounds an upload, a download and a snapshot by configured byte limits', async () => {
  const host = await fixture()
  const data = Buffer.from('destination bytes').toString('base64')
  host.config.maxUploadBytes = 5
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'upload', name: 'review.txt', data }, signal)).rejects.toThrow('Upload exceeds')
  host.config.maxUploadBytes = 1048576
  const uploaded = await host.interactions.run(host.peer, { ...host.address, action: 'upload', name: 'review.txt', data }, signal)
  if (uploaded.kind !== 'uploaded') throw new Error('Expected upload receipt')
  await host.sessions.run(host.peer, { ...host.address, action: 'prompt', requestId: brandString<SessionRequestId>(randomUUID()), text: 'Review', attachments: [uploaded.upload.receiptId] }, signal)
  await finishTurn(host)
  const download = { ...host.address, action: 'download', attachmentId: uploaded.upload.file.attachmentId } as const
  host.config.maxUploadBytes = 5
  await expect(host.interactions.run(host.peer, download, signal)).rejects.toThrow('Download exceeds')
  host.config.maxUploadBytes = 50
  vi.spyOn(host.ctx.attachments, 'readFileStream').mockImplementation(async function* () { yield new Uint8Array(100) })
  await expect(host.interactions.run(host.peer, download, signal)).rejects.toThrow('Download exceeds')
  host.config.maxUploadBytes = 1048576
  const snapshot = { ...host.address, action: 'snapshot' } as const
  host.config.maxBytes = Buffer.byteLength(JSON.stringify(snapshot)) + 10
  await expect(host.interactions.run(host.peer, snapshot, signal)).rejects.toMatchObject({ code: 'environment/session-protocol' })
})

it('denies a download of an attachment the Session does not reference', async () => {
  const host = await fixture()
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'download', attachmentId: brandString<Extract<EnvironmentInteractionRequest, { action: 'download' }>['attachmentId']>('unknown') }, signal)).rejects.toMatchObject({ code: 'environment/session-denied' })
})

it('reports committed tool calls, tool results and turn failures, and names unnamed images by attachment', async () => {
  const host = await fixture()
  const stream = vi.spyOn(host.adapter, 'stream')
  stream.mockImplementationOnce(async function* () { yield* toolCallResponse('call-1', 'missing_tool', {}) })
  await prompt(host, { text: 'Use a tool' })
  stream.mockImplementationOnce(async function* () { await Promise.resolve(); throw new Error('model failed') })
  await prompt(host, { text: 'Fail' })
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
  await prompt(host, { text: 'Image', images: [{ data: pixel, mediaType: 'image/png' }] })
  const snapshot = await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)
  if (snapshot.kind !== 'snapshot') throw new Error('Expected snapshot')
  expect(snapshot.details.map(detail => detail.kind)).toEqual(expect.arrayContaining(['tool-call', 'tool-result', 'error']))
  expect(snapshot.details.find(detail => detail.kind === 'tool-call')).toMatchObject({ title: 'missing_tool', callId: 'call-1', isError: false })
  expect(snapshot.details.find(detail => detail.kind === 'tool-result')).toMatchObject({ callId: 'call-1' })
  expect(snapshot.details.find(detail => detail.kind === 'error')).toMatchObject({ isError: true })
  expect(snapshot.attachments).toHaveLength(1)
  expect(snapshot.attachments[0]).toMatchObject({ mediaType: 'image/png' })
  expect(snapshot.attachments[0]?.name).toBe(snapshot.attachments[0]?.attachmentId)
})

it('keeps the call identity of a pending approval and rejects an answer to an approval', async () => {
  const host = await fixture()
  const result = Promise.withResolvers<TypertRemoteEventOutcome>()
  const actor = { id: host.address.sessionId }
  await publish(host, { event: 'approval/request', request: { agent: actor, toolName: 'write_file', callId: ToolCallId('call-9'), signal }, context: { value: host.ctx, subject: actor, agentId: actor.id }, resolve: result.resolve, reject: result.reject }, 'approval/request')
  const snapshot = await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)
  if (snapshot.kind !== 'snapshot' || !snapshot.pending[0]) throw new Error('Expected pending approval')
  expect(snapshot.pending[0]).toMatchObject({ kind: 'approval', toolName: 'write_file', callId: 'call-9' })
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'answer', id: snapshot.pending[0].id, answer: { answers: [] } }, signal)).rejects.toThrow('no longer available')
  const approval = { ...host.address, action: 'approval', id: snapshot.pending[0].id, decision: 'rejected' } as const
  const respond = vi.spyOn(host.ctx.remoteEventAccess, 'respond').mockReturnValue(false)
  await expect(host.interactions.run(host.peer, approval, signal)).rejects.toThrow('already settled')
  respond.mockRestore()
  await host.interactions.run(host.peer, approval, signal)
  await expect(result.promise).resolves.toEqual({ kind: 'result', value: 'rejected' })
})

it('accepts a custom answer to a multi-select question and requires some answer for each question', async () => {
  const host = await fixture()
  const result = Promise.withResolvers<TypertRemoteEventOutcome>()
  const actor = { id: host.address.sessionId }
  const questions = [{ id: 'direction', question: 'Choose directions', multiSelect: true, options: [{ label: 'Left' }, { label: 'Right' }] }]
  await publish(host, { event: 'user-questions/request', request: { agent: actor, questions, signal }, context: { value: host.ctx, subject: actor, agentId: actor.id }, resolve: result.resolve, reject: result.reject }, 'user-questions/request')
  const snapshot = await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)
  if (snapshot.kind !== 'snapshot' || !snapshot.pending[0]) throw new Error('Expected pending question')
  const request = { ...host.address, action: 'answer', id: snapshot.pending[0].id } as const
  await expect(host.interactions.run(host.peer, { ...request, answer: { answers: [{ id: 'direction', selected: [] }] } }, signal)).rejects.toThrow('does not match')
  await expect(host.interactions.run(host.peer, { ...request, answer: { answers: [{ id: 'direction', selected: [], custom: '  ' }] } }, signal)).rejects.toThrow('does not match')
  const answer = { answers: [{ id: 'direction', selected: ['Left', 'Right'] }] }
  await host.interactions.run(host.peer, { ...request, answer }, signal)
  await expect(result.promise).resolves.toEqual({ kind: 'result', value: answer })
})

it('accepts a free-text answer without a selected option', async () => {
  const host = await fixture()
  const result = Promise.withResolvers<TypertRemoteEventOutcome>()
  const actor = { id: host.address.sessionId }
  await publish(host, { event: 'user-questions/request', request: { agent: actor, questions: [{ id: 'note', question: 'Anything else?' }], signal }, context: { value: host.ctx, subject: actor, agentId: actor.id }, resolve: result.resolve, reject: result.reject }, 'user-questions/request')
  const snapshot = await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)
  if (snapshot.kind !== 'snapshot' || !snapshot.pending[0]) throw new Error('Expected pending question')
  const answer = { answers: [{ id: 'note', selected: [], custom: 'free text' }] }
  await host.interactions.run(host.peer, { ...host.address, action: 'answer', id: snapshot.pending[0].id, answer }, signal)
  await expect(result.promise).resolves.toEqual({ kind: 'result', value: answer })
})

it('routes granted terminal operations to the Session terminal controller', async () => {
  const host = await fixture()
  const controller = host.ctx.terminalController
  const info = terminalInfo(terminalId, host.cwd)
  const create = vi.spyOn(controller, 'create').mockResolvedValue(info)
  const write = vi.spyOn(controller, 'write').mockResolvedValue()
  const resize = vi.spyOn(controller, 'resize').mockResolvedValue()
  const close = vi.spyOn(controller, 'close').mockResolvedValue()
  const list = vi.spyOn(controller, 'list').mockReturnValue([info])
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'terminal-create', request: { id: terminalId, cols: 80, rows: 24 } }, signal)).toMatchObject({ kind: 'terminal', terminal: info })
  expect(owners(create.mock.calls)).toEqual([[host.address.sessionId, { id: terminalId, cols: 80, rows: 24 }, signal]])
  const acknowledged = { kind: 'acknowledged', sessionId: host.address.sessionId }
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'terminal-write', terminalId, attachmentId, data: 'ls\n' }, signal)).toMatchObject(acknowledged)
  expect(owners(write.mock.calls)).toEqual([[host.address.sessionId, terminalId, attachmentId, 'ls\n']])
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'terminal-resize', terminalId, attachmentId, cols: 100, rows: 30 }, signal)).toMatchObject(acknowledged)
  expect(owners(resize.mock.calls)).toEqual([[host.address.sessionId, terminalId, attachmentId, 100, 30]])
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'terminal-close', terminalId }, signal)).toMatchObject(acknowledged)
  expect(owners(close.mock.calls)).toEqual([[host.address.sessionId, terminalId]])
  expect(await host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)).toMatchObject({ terminals: [info], capabilities: { terminals: true } })
  expect(list).toHaveBeenCalledWith(host.address.sessionId)
  host.grant.terminalAccess = false
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'terminal-close', terminalId }, signal)).rejects.toMatchObject({ code: 'environment/session-denied' })
})

it('follows a terminal under its own grant and bounds each frame', async () => {
  const host = await fixture()
  const request: EnvironmentTerminalFollowRequest = { ...host.address, terminalId, attachmentId }
  const frames: TerminalFrame[] = [{ type: 'snapshot', sequence: 0, screen: 'screen', info: terminalInfo(terminalId, host.cwd) }, { type: 'output', sequence: 1, data: 'first' }]
  const follow = vi.spyOn(host.ctx.terminalController, 'follow').mockImplementation(async function* () { yield* frames })
  const received: EnvironmentTerminalFrame[] = []
  for await (const frame of host.interactions.followTerminal(host.peer, request, signal)) received.push(frame)
  expect(received).toEqual(frames.map(frame => ({ environmentId: host.id, ...host.address, terminalId, frame })))
  expect(owners(follow.mock.calls)).toEqual([[host.address.sessionId, terminalId, attachmentId, signal]])
  host.config.maxBytes = 10
  await expect((async () => { for await (const _frame of host.interactions.followTerminal(host.peer, request, signal)) { /* the first frame exceeds the byte limit */ } })()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  host.config.maxBytes = 1048576
  host.grant.terminalAccess = false
  await expect((async () => { for await (const _frame of host.interactions.followTerminal(host.peer, request, signal)) { /* denied before any frame */ } })()).rejects.toMatchObject({ code: 'environment/session-denied' })
})

it('refuses Sessions outside the workspace and Sessions that cannot be activated', async () => {
  const host = await fixture()
  const inspect = host.controller.inspect.bind(host.controller)
  vi.spyOn(host.controller, 'inspect').mockImplementationOnce(async (...args) => {
    const inspection = await inspect(...args)
    return { ...inspection, meta: { ...inspection.meta, origin: 'subagent' } }
  })
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)).rejects.toMatchObject({ code: 'environment/session-denied' })
  vi.spyOn(host.controller, 'resolveAgent').mockResolvedValue({ error: new RemoteError('session/not-found', 'missing', { sessionId: host.address.sessionId }) })
  const upload = { ...host.address, action: 'upload', name: 'a.txt', data: 'AAAA' } as const
  await expect(host.interactions.run(host.peer, upload, signal)).rejects.toThrow('could not be activated')
})

it('fails when a required destination service disappears', async () => {
  const host = await fixture()
  const get: (name: string, strict?: boolean) => object | undefined = host.ctx.get.bind(host.ctx)
  const hidden = new Set<string>()
  vi.spyOn(host.ctx, 'get').mockImplementation((name, strict) => hidden.has(name) ? undefined : get(name, strict) as never)
  hidden.add('sessionController')
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)).rejects.toThrow('Session controller is unavailable')
  hidden.clear()
  const resolveAgent = host.controller.resolveAgent.bind(host.controller)
  vi.spyOn(host.controller, 'resolveAgent').mockImplementationOnce(async (...args) => {
    hidden.add('fileUploads')
    return resolveAgent(...args)
  })
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'upload', name: 'a.txt', data: 'AAAA' }, signal)).rejects.toThrow('Destination service is unavailable: fileUploads')
})

it('rejects an action that the request parser accepted but the service does not implement', async () => {
  const host = await fixture()
  vi.spyOn(interactionRequestSchema, 'parse').mockReturnValueOnce({ ...host.address, action: 'unsupported' } as never)
  await expect(host.interactions.run(host.peer, { ...host.address, action: 'snapshot' }, signal)).rejects.toThrow()
})
