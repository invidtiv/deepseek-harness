/** Destination selection, reconnect and ambiguous mutation ownership. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteSessionController, type SessionCall, type SessionFollow } from '../src/client/session-controller.ts'
import type { EnvironmentWorkspace } from '../src/workspace-types.ts'
import type { SessionResult, EnvironmentSessionSummary } from '../src/session-types.ts'

const workspace: EnvironmentWorkspace = { environmentId: brandString<EnvironmentWorkspace['environmentId']>('11111111-1111-4111-8111-111111111111'), workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('workspace'), alias: 'project', relativePath: '', path: '/srv/project', title: 'Project' }
const sessionId = brandString<EnvironmentSessionSummary['sessionId']>('22222222-2222-4222-8222-222222222222')
const base = { environmentId: workspace.environmentId, workspaceId: workspace.workspaceId }
const list: SessionResult = { ...base, kind: 'sessions', sessions: [{ sessionId, title: 'Remote session', running: false, updatedAt: 1 }], truncated: false }
const snapshot: SessionResult = { ...base, kind: 'snapshot', sessionId, cursor: 1, running: false, messages: [{ seq: 1, role: 'assistant', text: 'Saved remotely' }], truncated: false }
const roots: RemoteSessionController[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.dispose())); vi.useRealTimers() })
function followSnapshot(call: SessionCall): SessionFollow {
  return async function* (environment, request, signal) {
    const frame = await call(environment, { action: 'read', ...request }, signal)
    if (frame.kind === 'snapshot') yield frame
    if (signal.aborted) return
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }
}
function fixture(call: SessionCall = async (_environment, request) => request.action === 'list' ? list : snapshot, interval = vi.fn(async () => 1000)) {
  const notify = vi.fn()
  const controller = new RemoteSessionController(call, interval, notify, followSnapshot(call))
  roots.push(controller); controller.open(workspace); controller.resume()
  return { controller, notify, interval }
}

it('retains exact attachment receipts and image bytes through an uncertain prompt retry', async () => {
  let attempts = 0
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'prompt') {
      if (++attempts === 1) throw new Error('response lost')
      return { ...base, kind: 'accepted', sessionId }
    }
    return request.action === 'list' ? list : snapshot
  })
  const { controller } = fixture(call)
  controller.select(sessionId)
  const receipt = brandString<NonNullable<Extract<import('../src/session-types.ts').SessionRequest, { action: 'prompt' }>['attachments']>[number]>('receipt')
  const image = { data: 'aGVsbG8=', mediaType: 'image/png' as const, name: 'picture.png' }
  controller.stage(sessionId, { name: 'notes.txt', receipt })
  controller.stage(sessionId, { name: 'picture.png', image })
  await controller.send()
  expect(controller.state.getSnapshot().uncertain).toBe(true)
  controller.removeAttachment(0)
  expect(controller.state.getSnapshot().attachments).toHaveLength(2)
  await controller.send()
  const prompts = call.mock.calls.map(([, request]) => request).filter(request => request.action === 'prompt')
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toEqual(prompts[1])
  expect(prompts[0]).toMatchObject({ text: '', attachments: [receipt], images: [image] })
  expect(controller.state.getSnapshot().attachments).toBeUndefined()
})

it('discards uploads after selection changes and allows removing unsent attachments', async () => {
  const { controller } = fixture()
  controller.select(sessionId)
  const attachment = { name: 'image.png', image: { data: 'aGVsbG8=', mediaType: 'image/png' as const } }
  controller.stage(brandString<EnvironmentSessionSummary['sessionId']>('other'), attachment)
  expect(controller.state.getSnapshot().attachments).toBeUndefined()
  controller.stage(sessionId, attachment); controller.removeAttachment(0)
  expect(controller.state.getSnapshot().attachments).toEqual([])
  controller.stage(sessionId, attachment)
  controller.select(brandString<EnvironmentSessionSummary['sessionId']>('other'))
  expect(controller.state.getSnapshot().attachments).toBeUndefined()
})

it('polls destination snapshots and retains messages while disconnected, then recovers', async () => {
  vi.useFakeTimers()
  let offline = false
  const call = vi.fn<SessionCall>(async (_environment, request) => { if (offline) throw new Error('offline'); return request.action === 'list' ? list : snapshot })
  const { controller } = fixture(call)
  await vi.advanceTimersByTimeAsync(0)
  controller.select(sessionId)
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.state.getSnapshot().transcript?.messages[0]?.text).toBe('Saved remotely')
  offline = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(controller.state.getSnapshot()).toMatchObject({ offline: true, transcript: snapshot })
  offline = false
  await vi.advanceTimersByTimeAsync(1000)
  expect(controller.state.getSnapshot().offline).toBe(false)
  expect(call.mock.calls.every(args => args[0] === workspace.environmentId)).toBe(true)
})

it('ignores an old machine response after selecting another workspace', async () => {
  let finish!: (value: SessionResult) => void
  const pending = new Promise<SessionResult>((resolve) => { finish = resolve })
  const { controller } = fixture(vi.fn<SessionCall>().mockReturnValueOnce(pending).mockResolvedValue(list))
  const other = { ...workspace, environmentId: brandString<EnvironmentWorkspace['environmentId']>('33333333-3333-4333-8333-333333333333') }
  controller.open(other)
  await controller.refresh()
  finish({ ...list, sessions: [{ sessionId, title: 'Stale', running: false, updatedAt: 1 }] })
  await Promise.resolve()
  expect(controller.state.getSnapshot().workspace).toEqual(other)
  expect(controller.state.getSnapshot().list?.sessions[0]?.title).toBe('Remote session')
})

it('retries an ambiguous prompt with one request identity and preserves the draft', async () => {
  let prompts = 0
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'prompt') {
      if (++prompts === 1) throw new Error('response lost')
      return { ...base, kind: 'accepted', sessionId }
    }
    return request.action === 'list' ? list : snapshot
  })
  const { controller, notify } = fixture(call)
  controller.select(sessionId); await controller.refresh()
  controller.draft('Do the work'); await controller.send()
  expect(controller.state.getSnapshot()).toMatchObject({ draft: 'Do the work', uncertain: true, busy: false })
  controller.draft('Replacement ignored')
  await controller.send()
  const requests = call.mock.calls.map(args => args[1]).filter(request => request.action === 'prompt')
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1])
  expect(controller.state.getSnapshot()).toMatchObject({ draft: '', uncertain: false })
  expect(notify.mock.calls).toEqual([[false], [true]])
})

it('pausing a pending mutation releases busy state and retains its retry identity', async () => {
  let finish!: (value: SessionResult) => void
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'prompt') return new Promise((resolve) => { finish = resolve })
    return request.action === 'list' ? list : snapshot
  })
  const { controller } = fixture(call)
  controller.select(sessionId); await controller.refresh(); controller.draft('Pending')
  const send = controller.send()
  await controller.refresh()
  expect(controller.state.getSnapshot().busy).toBe(true)
  controller.pause()
  expect(controller.state.getSnapshot()).toMatchObject({ busy: false, uncertain: true })
  finish({ ...base, kind: 'accepted', sessionId }); await send
  expect(controller.state.getSnapshot().draft).toBe('Pending')
  controller.resume(); await controller.refresh()
  expect(controller.state.getSnapshot().busy).toBe(false)
})

it('continues retrying with the last configured interval if configuration becomes unavailable', async () => {
  vi.useFakeTimers()
  const interval = vi.fn(async () => 1000)
  const call = vi.fn<SessionCall>().mockResolvedValue(list)
  fixture(call, interval)
  await vi.advanceTimersByTimeAsync(0)
  interval.mockRejectedValue(new Error('local host offline'))
  await vi.advanceTimersByTimeAsync(3000)
  expect(call).toHaveBeenCalledTimes(4)
})

it('creates a session with a stable retry identity and cancels only the selected destination', async () => {
  let creates = 0
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'create') {
      if (++creates === 1) throw new Error('response lost')
      return { ...base, kind: 'created', sessionId: request.sessionId }
    }
    if (request.action === 'cancel') return { ...base, kind: 'cancelled', sessionId: request.sessionId }
    return request.action === 'list' ? list : snapshot
  })
  const { controller } = fixture(call)
  await controller.create(); await controller.create()
  const requests = call.mock.calls.map(args => args[1]).filter(request => request.action === 'create')
  expect(requests[0]).toEqual(requests[1])
  expect(controller.state.getSnapshot().sessionId).toBe(requests[0]?.sessionId)
  await controller.cancel()
  expect(call.mock.calls.some(args => args[0] === workspace.environmentId && args[1].action === 'cancel' && args[1].sessionId === requests[0]?.sessionId)).toBe(true)
})

it('clears an older ambiguous prompt when a new session is created', async () => {
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'prompt') throw new Error('response lost')
    if (request.action === 'create') return { ...base, kind: 'created', sessionId: request.sessionId }
    return request.action === 'list' ? list : snapshot
  })
  const { controller } = fixture(call)
  controller.select(sessionId); await controller.refresh(); controller.draft('Old message'); await controller.send()
  expect(controller.state.getSnapshot().uncertain).toBe(true)
  await controller.create(); controller.draft('New message')
  expect(controller.state.getSnapshot()).toMatchObject({ uncertain: false, draft: 'New message' })
})

it('ignores actions without a target and stale destination endpoint metadata', async () => {
  const call = vi.fn<SessionCall>().mockResolvedValue(list)
  const controller = new RemoteSessionController(call, async () => 1000, vi.fn(), followSnapshot(call))
  roots.push(controller)
  controller.resume(); await controller.create(); await controller.send(); await controller.cancel()
  controller.destination(workspace.environmentId, 'https://stale.example.ts.net')
  expect(call).not.toHaveBeenCalled()
  controller.open(workspace); await controller.send(); await controller.cancel()
  controller.select(sessionId); await controller.send()
  expect(call.mock.calls.filter(args => args[1].action !== 'list' && args[1].action !== 'read')).toEqual([])
})

it('blocks competing navigation and mutations until the active operation settles', async () => {
  let reject!: (error: Error) => void
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'cancel') return new Promise((_resolve, rejectPromise) => { reject = rejectPromise })
    return request.action === 'list' ? list : snapshot
  })
  const { controller } = fixture(call)
  controller.select(sessionId); await controller.refresh(); controller.draft('Keep')
  const cancel = controller.cancel()
  controller.select(sessionId); controller.draft('Ignored'); await controller.create(); await controller.send(); await controller.cancel()
  expect(controller.state.getSnapshot().draft).toBe('Keep')
  controller.pause(); reject(new Error('aborted')); await cancel
  expect(controller.state.getSnapshot().busy).toBe(false)
})

it('discards rejected reads and configuration completions from superseded panels', async () => {
  let rejectRead!: (error: Error) => void
  const { controller } = fixture(() => new Promise((_resolve, reject) => { rejectRead = reject }))
  controller.pause(); rejectRead(new Error('stale')); await Promise.resolve(); await Promise.resolve()
  expect(controller.state.getSnapshot().offline).toBe(false)
  let rejectConfig!: (error: Error) => void
  const second = fixture(async () => list, vi.fn(() => new Promise<number>((_resolve, reject) => { rejectConfig = reject })))
  await Promise.resolve(); await Promise.resolve()
  second.controller.pause(); rejectConfig(new Error('stale config')); await Promise.resolve(); await Promise.resolve()
  expect(second.controller.state.getSnapshot().offline).toBe(false)
})

it('does not schedule polling after a snapshot subscriber closes its panel', async () => {
  const { controller, interval } = fixture()
  const dispose = controller.state.subscribe(() => {
    if (controller.state.getSnapshot().list && !controller.state.getSnapshot().offline) { dispose(); controller.pause() }
  })
  await Promise.resolve(); await Promise.resolve()
  expect(interval).not.toHaveBeenCalled()
})

it('reports an invalid creation response without changing the selected session', async () => {
  const { controller, notify } = fixture(async () => list)
  await controller.create()
  expect(notify).toHaveBeenCalledWith(false)
  expect(controller.state.getSnapshot().sessionId).toBeUndefined()
})

it('keeps unrelated response kinds out of the catalog and transcript', async () => {
  const { controller } = fixture(async () => ({ ...base, kind: 'cancelled', sessionId }))
  controller.select(sessionId); await controller.refresh()
  expect(controller.state.getSnapshot()).toMatchObject({ loading: false, offline: false })
  expect(controller.state.getSnapshot().transcript).toBeUndefined()
  expect(controller.state.getSnapshot().list).toBeUndefined()
})
