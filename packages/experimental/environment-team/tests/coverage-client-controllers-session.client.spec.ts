/** Session controller conversation restoration, paging preconditions and superseded paging failures. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteSessionController, type RemoteDraftAttachment, type SessionCall, type SessionFollow } from '../src/client/session-controller.ts'
import type { EnvironmentSessionFrame, EnvironmentSessionSummary, SessionResult } from '../src/session-types.ts'
import type { EnvironmentWorkspace } from '../src/workspace-types.ts'

const workspace: EnvironmentWorkspace = { environmentId: brandString<EnvironmentWorkspace['environmentId']>('11111111-1111-4111-8111-111111111111'), workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('workspace'), alias: 'project', relativePath: '', path: '/srv/project', title: 'Project' }
const sessionId = brandString<EnvironmentSessionSummary['sessionId']>('22222222-2222-4222-8222-222222222222')
const other = brandString<EnvironmentSessionSummary['sessionId']>('other')
const base = { environmentId: workspace.environmentId, workspaceId: workspace.workspaceId }
const list: Extract<SessionResult, { kind: 'sessions' }> = { ...base, kind: 'sessions', sessions: [{ sessionId, title: 'Remote session', running: false, updatedAt: 1 }], truncated: false }
const frame: EnvironmentSessionFrame = { ...base, kind: 'snapshot', sessionId, cursor: 1, running: false, messages: [{ seq: 1, role: 'assistant', text: 'Saved remotely' }], truncated: false }
const roots: RemoteSessionController[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.dispose())); vi.useRealTimers() })
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}
const idle: SessionFollow = async function* (_environment, _request, signal) { yield frame; await untilAborted(signal) }
function fixture(call: SessionCall, follow: SessionFollow = idle, options: { open?: boolean } = {}) {
  const notify = vi.fn()
  const controller = new RemoteSessionController(call, async () => 1000, notify, follow)
  roots.push(controller)
  if (options.open !== false) { controller.open(workspace); controller.resume() }
  return { controller, notify }
}
function untilPageable(controller: RemoteSessionController): Promise<void> {
  return vi.waitFor(() => {
    expect(controller.state.getSnapshot()).toMatchObject({ transcript: { truncated: true }, list: { truncated: true } })
  })
}
const requests = (call: ReturnType<typeof vi.fn<SessionCall>>) => call.mock.calls.map(([, request]) => request)

it('restores transcript, stream failure and staged attachments when returning to a conversation', async () => {
  const follow: SessionFollow = async function* (_environment, request, signal) {
    if (request.sessionId !== sessionId) { await untilAborted(signal); return }
    yield frame
    throw new RemoteError('environment/session-denied', 'denied', {})
  }
  const { controller } = fixture(async () => list, follow)
  controller.select(sessionId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot()).toMatchObject({ transcript: frame, streamFailure: 'sessionDenied' }) })
  const attachment = { name: 'notes.txt', receipt: brandString<NonNullable<RemoteDraftAttachment['receipt']>>('receipt') }
  controller.stage({ ...workspace, sessionId }, attachment)
  controller.select(other)
  expect(controller.state.getSnapshot()).toMatchObject({ sessionId: other, loading: true })
  expect(controller.state.getSnapshot().transcript).toBeUndefined()
  expect(controller.state.getSnapshot().streamFailure).toBeUndefined()
  expect(controller.state.getSnapshot().attachments).toBeUndefined()
  controller.select(sessionId)
  expect(controller.state.getSnapshot()).toMatchObject({ sessionId, transcript: frame, streamFailure: 'sessionDenied', attachments: [attachment] })
})

it('ignores attachment removal when nothing is staged', () => {
  const { controller } = fixture(async () => list)
  controller.removeAttachment(0)
  expect(controller.state.getSnapshot().attachments).toBeUndefined()
})

it('does not page without a destination, an open page or an anchor entry', async () => {
  const call = vi.fn<SessionCall>(async () => list)
  const { controller } = fixture(call, idle, { open: false })
  await controller.olderSessions(); await controller.earlier()
  controller.open(workspace); controller.resume()
  await controller.refresh()
  await controller.olderSessions(); await controller.earlier()
  controller.select(sessionId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript).toEqual(frame) })
  await controller.olderSessions(); await controller.earlier()
  expect(requests(call).every(request => request.action === 'list' && request.before === undefined)).toBe(true)
})

it('does not page a truncated page that has no entries to anchor on', async () => {
  const call = vi.fn<SessionCall>(async () => ({ ...list, sessions: [], truncated: true }))
  const follow: SessionFollow = async function* (_environment, _request, signal) {
    yield { ...frame, messages: [], truncated: true }
    await untilAborted(signal)
  }
  const { controller } = fixture(call, follow)
  controller.select(sessionId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript?.truncated).toBe(true) })
  await controller.refresh()
  await controller.olderSessions(); await controller.earlier()
  expect(requests(call).every(request => request.action === 'list' && request.before === undefined)).toBe(true)
  expect(controller.state.getSnapshot()).toMatchObject({ list: { sessions: [], truncated: true } })
})

it('does not start a second page read while one is loading', async () => {
  const older = Promise.withResolvers<SessionResult>()
  const earlier = Promise.withResolvers<SessionResult>()
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'list') return request.before ? older.promise : { ...list, truncated: true }
    return request.action === 'read' && request.beforeSeq !== undefined ? earlier.promise : frame
  })
  const follow: SessionFollow = async function* (_environment, _request, signal) {
    yield { ...frame, truncated: true }
    await untilAborted(signal)
  }
  const { controller } = fixture(call, follow)
  controller.select(sessionId)
  await untilPageable(controller)
  const pendingCatalog = controller.olderSessions(); const pendingHistory = controller.earlier()
  await controller.olderSessions(); await controller.earlier()
  expect(requests(call).filter(request => request.action === 'list' && request.before)).toHaveLength(1)
  expect(requests(call).filter(request => request.action === 'read' && request.beforeSeq !== undefined)).toHaveLength(1)
  older.resolve({ ...list, sessions: [], truncated: false }); earlier.resolve({ ...frame, messages: [], truncated: false })
  await pendingCatalog; await pendingHistory
  expect(controller.state.getSnapshot()).toMatchObject({ catalogHistory: { sessions: [] }, history: { messages: [] } })
})

it('reports another result kind for a page as a failed read without replacing the displayed page', async () => {
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'list') return request.before ? { ...base, kind: 'cancelled', sessionId } : { ...list, truncated: true }
    return request.action === 'read' && request.beforeSeq !== undefined ? { ...base, kind: 'cancelled', sessionId } : frame
  })
  const follow: SessionFollow = async function* (_environment, _request, signal) {
    yield { ...frame, truncated: true }
    await untilAborted(signal)
  }
  const { controller, notify } = fixture(call, follow)
  controller.select(sessionId)
  await untilPageable(controller)
  await controller.olderSessions()
  expect(notify).toHaveBeenCalledTimes(1)
  await controller.earlier()
  expect(notify).toHaveBeenCalledTimes(2)
  expect(notify).toHaveBeenLastCalledWith(false)
  expect(controller.state.getSnapshot().catalogHistory).toBeUndefined()
  expect(controller.state.getSnapshot().history).toBeUndefined()
  expect(controller.state.getSnapshot().catalogLoading).toBeUndefined()
  expect(controller.state.getSnapshot().historyLoading).toBeUndefined()
})

it.each(['catalog', 'history'] as const)('does not report a %s page failure after the page was abandoned', async (kind) => {
  const failure = Promise.withResolvers<SessionResult>()
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'list') return request.before ? failure.promise : { ...list, truncated: true }
    return request.action === 'read' && request.beforeSeq !== undefined ? failure.promise : frame
  })
  const follow: SessionFollow = async function* (_environment, _request, signal) {
    yield { ...frame, truncated: true }
    await untilAborted(signal)
  }
  const { controller, notify } = fixture(call, follow)
  controller.select(sessionId)
  await untilPageable(controller)
  const pending = kind === 'catalog' ? controller.olderSessions() : controller.earlier()
  if (kind === 'catalog') controller.backToLatestSessions(); else controller.backToLive()
  failure.reject(new RemoteError('environment/session-unsupported', 'unsupported', {}))
  await pending
  expect(notify).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot().catalogUnsupported).toBeUndefined()
  expect(controller.state.getSnapshot().historyUnsupported).toBeUndefined()
})
