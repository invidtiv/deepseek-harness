/** Destination selection, reconnect and ambiguous mutation ownership. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
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
  controller.stage({ ...workspace, sessionId }, { name: 'notes.txt', receipt })
  controller.stage({ ...workspace, sessionId }, { name: 'picture.png', image })
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
  controller.stage({ ...workspace, sessionId: brandString<EnvironmentSessionSummary['sessionId']>('other') }, attachment)
  expect(controller.state.getSnapshot().attachments).toBeUndefined()
  controller.stage({ ...workspace, sessionId }, attachment); controller.removeAttachment(0)
  expect(controller.state.getSnapshot().attachments).toEqual([])
  controller.stage({ ...workspace, sessionId }, attachment)
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


it('restores selections and drafts by machine and workspace even when session IDs collide', async () => {
  const { controller } = fixture()
  const other = { ...workspace, environmentId: brandString<EnvironmentWorkspace['environmentId']>('other-machine') }
  const another = { ...workspace, workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('another-workspace') }
  controller.select(sessionId); await controller.refresh(); controller.draft('First draft')
  const attachment = { name: 'image.png', image: { data: 'aGVsbG8=', mediaType: 'image/png' as const } }
  controller.stage({ ...workspace, sessionId }, attachment)
  controller.open(other); controller.select(sessionId); controller.draft('Other machine')
  controller.stage({ ...workspace, sessionId }, attachment)
  expect(controller.state.getSnapshot().attachments).toBeUndefined()
  controller.open(another); controller.select(sessionId); controller.draft('Other workspace')
  controller.open(workspace)
  expect(controller.state.getSnapshot()).toMatchObject({ sessionId, draft: 'First draft', attachments: [attachment], list })
  expect(controller.state.getSnapshot().recentWorkspaces).toEqual([workspace, another, other])
  controller.open(other)
  expect(controller.state.getSnapshot()).toMatchObject({ sessionId, draft: 'Other machine' })
  controller.open(another)
  expect(controller.state.getSnapshot()).toMatchObject({ sessionId, draft: 'Other workspace' })
  await controller.dispose()
  controller.open(workspace)
  expect(controller.state.getSnapshot()).toMatchObject({ draft: '' })
  expect(controller.state.getSnapshot().sessionId).toBeUndefined()
})

it('restores an ambiguous prompt unchanged after visiting another session and machine', async () => {
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'prompt') throw new Error('acknowledgement lost')
    return request.action === 'list' ? list : snapshot
  })
  const { controller } = fixture(call)
  const otherSession = brandString<EnvironmentSessionSummary['sessionId']>('other-session')
  controller.select(sessionId); controller.draft('Retry exactly this'); await controller.send()
  controller.select(otherSession); controller.draft('Independent draft')
  controller.open({ ...workspace, environmentId: brandString<EnvironmentWorkspace['environmentId']>('other-machine') })
  controller.select(sessionId); controller.draft('Different machine')
  controller.open(workspace)
  expect(controller.state.getSnapshot()).toMatchObject({ sessionId: otherSession, draft: 'Independent draft', uncertain: false })
  controller.select(sessionId)
  expect(controller.state.getSnapshot()).toMatchObject({ draft: 'Retry exactly this', uncertain: true })
  const prompts = () => call.mock.calls.filter(([, request]) => request.action === 'prompt')
  expect(prompts()).toHaveLength(1)
  await controller.send()
  expect(prompts()).toHaveLength(2)
  expect(prompts()[1]?.slice(0, 2)).toEqual(prompts()[0]?.slice(0, 2))
})

it('keeps a creation retry identity with its workspace while visiting another machine', async () => {
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'create') throw new Error('acknowledgement lost')
    return request.action === 'list' ? list : snapshot
  })
  const { controller } = fixture(call)
  await controller.create()
  controller.open({ ...workspace, environmentId: brandString<EnvironmentWorkspace['environmentId']>('other-machine') })
  await controller.create()
  controller.open(workspace)
  await controller.create()
  const creates = call.mock.calls.filter(([, request]) => request.action === 'create')
  expect(creates).toHaveLength(3)
  expect(creates[0]?.slice(0, 2)).toEqual(creates[2]?.slice(0, 2))
  expect(creates[1]?.[1]).not.toEqual(creates[0]?.[1])
})


it('refreshes the selected machine immediately when switching an already visible panel', async () => {
  const call = vi.fn<SessionCall>(async (environment, request) => request.action === 'list'
    ? { ...list, environmentId: environment } : { ...snapshot, environmentId: environment })
  const { controller } = fixture(call)
  controller.select(sessionId)
  await controller.refresh()
  const other = { ...workspace, environmentId: brandString<EnvironmentWorkspace['environmentId']>('other-machine') }
  controller.open(other)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().list?.environmentId).toBe(other.environmentId) })
  controller.select(sessionId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript?.environmentId).toBe(other.environmentId) })
  controller.open(workspace)
  await vi.waitFor(() => {
    expect(controller.state.getSnapshot().transcript?.environmentId).toBe(workspace.environmentId)
    expect(controller.state.getSnapshot().loading).toBe(false)
  })
})


it('pages backward independently of live refresh and retains the last page on failure', async () => {
  let fail = false
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'read' && request.beforeSeq !== undefined) {
      if (fail) throw new Error('offline')
      return { ...snapshot, messages: [{ seq: request.beforeSeq - 1, role: 'user', text: 'Earlier' }], truncated: true }
    }
    return request.action === 'list' ? list : { ...snapshot, messages: [{ seq: 10, role: 'assistant', text: 'Live' }], truncated: true }
  })
  const { controller, notify } = fixture(call)
  controller.select(sessionId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript?.messages[0]?.seq).toBe(10) })
  await controller.earlier()
  expect(controller.state.getSnapshot().history?.messages[0]?.seq).toBe(9)
  await controller.refresh(); await controller.earlier()
  expect(controller.state.getSnapshot().history?.messages[0]?.seq).toBe(8)
  expect(controller.state.getSnapshot().transcript?.messages[0]?.seq).toBe(10)
  fail = true; await controller.earlier()
  expect(controller.state.getSnapshot().history?.messages[0]?.seq).toBe(8)
  expect(notify).toHaveBeenCalledWith(false)
  controller.backToLive()
  expect(controller.state.getSnapshot().history).toBeUndefined()
  expect(controller.state.getSnapshot().transcript?.messages[0]?.seq).toBe(10)
})

it.each(['switch', 'reconnect', 'live', 'pause'] as const)('ignores a late history response after %s', async (action) => {
  let finish!: (value: SessionResult) => void
  let historySignal: AbortSignal | undefined
  const call = vi.fn<SessionCall>(async (_environment, request, signal) => {
    if (request.action === 'read' && request.beforeSeq !== undefined) {
      historySignal = signal
      return new Promise((resolve) => { finish = resolve })
    }
    return request.action === 'list' ? list : { ...snapshot, truncated: true }
  })
  const { controller } = fixture(call)
  controller.select(sessionId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript).toBeDefined() })
  const pending = controller.earlier()
  await controller.refresh()
  expect(historySignal?.aborted).toBe(false)
  if (action === 'switch') controller.open({ ...workspace, environmentId: brandString<EnvironmentWorkspace['environmentId']>('another') })
  else if (action === 'reconnect') controller.reconnect()
  else if (action === 'live') controller.backToLive()
  else controller.pause()
  expect(historySignal?.aborted).toBe(true)
  finish(snapshot); await pending
  expect(controller.state.getSnapshot().history).toBeUndefined()
  expect(controller.state.getSnapshot().historyLoading).toBeUndefined()
})


it('reports unsupported history while preserving live content and clears it on returning live', async () => {
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'read' && request.beforeSeq !== undefined) {
      throw new RemoteError('environment/session-unsupported', 'History unavailable', {})
    }
    return request.action === 'list' ? list : { ...snapshot, truncated: true }
  })
  const { controller, notify } = fixture(call)
  controller.select(sessionId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript).toBeDefined() })
  await controller.earlier()
  expect(controller.state.getSnapshot().historyUnsupported).toBe(true)
  expect(controller.state.getSnapshot().transcript?.messages).toEqual(snapshot.messages)
  expect(notify).not.toHaveBeenCalled()
  controller.backToLive()
  expect(controller.state.getSnapshot().historyUnsupported).toBeUndefined()
})


it('pages older catalogs without replacing the selected live conversation or its draft', async () => {
  let fail = false
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'list' && request.before) {
      if (fail) throw new Error('offline')
      return { ...list, sessions: [{ sessionId, title: 'Older', updatedAt: request.before.updatedAt - 1, running: false }], truncated: true }
    }
    return request.action === 'list' ? { ...list, truncated: true } : snapshot
  })
  const { controller, notify } = fixture(call)
  controller.select(sessionId); controller.draft('Unsent')
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript).toBeDefined() })
  const reads = () => call.mock.calls.filter(([, request]) => request.action === 'read').length
  const liveReads = reads()
  await controller.olderSessions()
  expect(controller.state.getSnapshot().catalogHistory?.sessions[0]?.updatedAt).toBe(0)
  await controller.refresh()
  expect(controller.state.getSnapshot().catalogHistory?.sessions[0]?.title).toBe('Older')
  expect(controller.state.getSnapshot().list?.sessions[0]?.title).toBe('Remote session')
  await controller.olderSessions()
  expect(controller.state.getSnapshot().catalogHistory?.sessions[0]?.updatedAt).toBe(-1)
  expect(reads()).toBe(liveReads)
  expect(controller.state.getSnapshot()).toMatchObject({ sessionId, draft: 'Unsent', transcript: snapshot })
  fail = true; await controller.olderSessions()
  expect(controller.state.getSnapshot().catalogHistory?.sessions[0]?.updatedAt).toBe(-1)
  expect(notify).toHaveBeenCalledWith(false)
  controller.select(brandString<EnvironmentSessionSummary['sessionId']>('other-session'))
  expect(controller.state.getSnapshot().catalogHistory?.sessions[0]?.title).toBe('Older')
  controller.backToLatestSessions()
  expect(controller.state.getSnapshot().catalogHistory).toBeUndefined()
})

it.each(['switch', 'reconnect', 'latest', 'pause'] as const)('ignores a late older catalog after %s', async (action) => {
  let finish!: (value: SessionResult) => void
  let signal: AbortSignal | undefined
  const call = vi.fn<SessionCall>(async (_environment, request, abort) => {
    if (request.action === 'list' && request.before) {
      signal = abort
      return new Promise((resolve) => { finish = resolve })
    }
    return request.action === 'list' ? { ...list, truncated: true } : snapshot
  })
  const { controller } = fixture(call)
  await controller.refresh()
  const pending = controller.olderSessions()
  await controller.refresh()
  expect(signal?.aborted).toBe(false)
  if (action === 'switch') controller.open({ ...workspace, workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('other') })
  else if (action === 'reconnect') controller.reconnect()
  else if (action === 'latest') controller.backToLatestSessions()
  else controller.pause()
  expect(signal?.aborted).toBe(true)
  finish(list); await pending
  expect(controller.state.getSnapshot().catalogHistory).toBeUndefined()
  expect(controller.state.getSnapshot().catalogLoading).toBeUndefined()
})

it('marks unsupported catalog paging without discarding the latest list', async () => {
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'list' && request.before) throw new RemoteError('environment/session-unsupported', 'Paging unavailable', {})
    return request.action === 'list' ? { ...list, truncated: true } : snapshot
  })
  const { controller, notify } = fixture(call)
  await controller.refresh(); await controller.olderSessions()
  expect(controller.state.getSnapshot().catalogUnsupported).toBe(true)
  expect(controller.state.getSnapshot().list?.sessions).toEqual(list.sessions)
  expect(notify).not.toHaveBeenCalled()
  controller.backToLatestSessions()
  expect(controller.state.getSnapshot().catalogUnsupported).toBeUndefined()
})


it('returns to recent catalogs after workspace switches and successful session creation', async () => {
  const call = vi.fn<SessionCall>(async (_environment, request) => {
    if (request.action === 'create') return { ...base, kind: 'created', sessionId: request.sessionId }
    return request.action === 'list' ? { ...list, truncated: !request.before } : snapshot
  })
  const { controller } = fixture(call)
  await controller.refresh(); await controller.olderSessions()
  expect(controller.state.getSnapshot().catalogHistory).toBeDefined()
  controller.open({ ...workspace, workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('other') })
  controller.open(workspace)
  expect(controller.state.getSnapshot().catalogHistory).toBeUndefined()
  await controller.refresh(); await controller.olderSessions()
  expect(controller.state.getSnapshot().catalogHistory).toBeDefined()
  await controller.create()
  expect(controller.state.getSnapshot().catalogHistory).toBeUndefined()
})
