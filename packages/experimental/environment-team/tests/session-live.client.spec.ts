/** Live snapshot replacement, destination isolation and independent reconnect ownership. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteSessionController, type SessionCall, type SessionFollow } from '../src/client/session-controller.ts'
import type { EnvironmentSessionFrame, EnvironmentSessionFollowRequest } from '../src/session-types.ts'
import type { EnvironmentWorkspace } from '../src/workspace-types.ts'

const workspace: EnvironmentWorkspace = { environmentId: brandString<EnvironmentWorkspace['environmentId']>('11111111-1111-4111-8111-111111111111'), workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('workspace'), alias: 'project', relativePath: '', path: '/srv/project', title: 'Project' }
const sessionId = brandString<EnvironmentSessionFollowRequest['sessionId']>('22222222-2222-4222-8222-222222222222')
const base: EnvironmentSessionFrame = { environmentId: workspace.environmentId, workspaceId: workspace.workspaceId, kind: 'snapshot', sessionId, cursor: 0, running: true, messages: [], truncated: false }
const attemptId = brandString<NonNullable<EnvironmentSessionFrame['live']>['attemptId']>('attempt')
const roots: RemoteSessionController[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.dispose())); vi.useRealTimers() })
const call: SessionCall = async (_environment, request) => request.action === 'list'
  ? { ...base, kind: 'sessions', sessions: [], truncated: false }
  : { ...base, kind: request.action === 'cancel' ? 'cancelled' : 'accepted' }
function fixture(follow: SessionFollow) {
  const controller = new RemoteSessionController(call, async () => 1000, vi.fn(), follow)
  roots.push(controller); controller.open(workspace); controller.select(sessionId); controller.resume()
  return controller
}
function channel() {
  let next: ((frame: EnvironmentSessionFrame | undefined) => void) | undefined
  let active = 0
  const follow = vi.fn<SessionFollow>(async function* (_environment, _request, signal) {
    active++
    try {
      yield base
      while (!signal.aborted) {
        const frame = await new Promise<EnvironmentSessionFrame | undefined>((resolve) => {
          const abort = (): void => { signal.removeEventListener('abort', abort); next = undefined; resolve(undefined) }
          next = (value) => { signal.removeEventListener('abort', abort); next = undefined; resolve(value) }
          signal.addEventListener('abort', abort, { once: true })
        })
        if (frame === undefined) return
        yield frame
      }
    } finally { active-- }
  })
  return { follow, active: () => active, push: (frame: EnvironmentSessionFrame | undefined) => { expect(next).toBeTypeOf('function'); next!(frame) } }
}

it('publishes a partial response immediately and replaces it once with its durable settlement', async () => {
  const stream = channel()
  const controller = fixture(stream.follow)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript).toEqual(base) })
  stream.push({ ...base, live: { attemptId, text: 'Partial' } })
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript?.live?.text).toBe('Partial') })
  await controller.refresh(); controller.draft('Next'); await controller.send(); await controller.cancel()
  expect(stream.follow).toHaveBeenCalledOnce()
  expect(controller.state.getSnapshot().transcript?.live?.text).toBe('Partial')
  const settled: EnvironmentSessionFrame = { ...base, cursor: 1, running: false, messages: [{ seq: 1, role: 'assistant', text: 'Partial complete' }] }
  stream.push(settled)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript).toEqual(settled) })
  await controller.dispose()
  expect(stream.active()).toBe(0)
})

it('reopens a dropped peer while the local host stays available and adopts its complete prefix', async () => {
  vi.useFakeTimers()
  let opens = 0
  const follow: SessionFollow = async function* (_environment, _request, signal) {
    yield { ...base, live: { attemptId, text: ++opens === 1 ? 'Before' : 'Before and after reconnect' } }
    if (opens === 1) return
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }
  const controller = fixture(follow)
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.state.getSnapshot()).toMatchObject({ offline: true, transcript: { live: { text: 'Before' } } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(opens).toBe(2)
  expect(controller.state.getSnapshot()).toMatchObject({ offline: false, transcript: { live: { text: 'Before and after reconnect' } } })
})

it.each(['environment/session-denied', 'environment/session-unsupported', 'environment/session-protocol'] as const)(
  'stops automatic follow retries for %s until an explicit refresh', async (code) => {
    vi.useFakeTimers()
    const follow = vi.fn<SessionFollow>(async function* () { throw new RemoteError(code, 'refused', {}) })
    const controller = fixture(follow)
    await vi.advanceTimersByTimeAsync(5000)
    expect(follow).toHaveBeenCalledOnce()
    expect(controller.state.getSnapshot().streamFailure).toBeTruthy()
    controller.reconnect(); await vi.advanceTimersByTimeAsync(0)
    expect(follow).toHaveBeenCalledTimes(2)
  },
)

it('disposes the old reader before opening another selection and discards late frames', async () => {
  let release!: () => void
  let active = 0
  const follow = vi.fn<SessionFollow>(async function* (_environment, request, signal) {
    active++
    try {
      if (request.sessionId === sessionId) {
        await new Promise<void>((resolve) => { release = resolve })
        yield { ...base, live: { attemptId, text: 'Late old text' } }
      } else {
        yield { ...base, sessionId: request.sessionId }
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      }
    } finally { active-- }
  })
  const controller = fixture(follow)
  await vi.waitFor(() => { expect(active).toBe(1) })
  const nextId = brandString<EnvironmentSessionFollowRequest['sessionId']>('33333333-3333-4333-8333-333333333333')
  controller.select(nextId)
  expect(follow).toHaveBeenCalledOnce()
  release()
  await vi.waitFor(() => { expect(controller.state.getSnapshot().transcript?.sessionId).toBe(nextId) })
  expect(controller.state.getSnapshot().transcript?.live).toBeUndefined()
  expect(active).toBe(1)
})

it('retries a classified unavailable peer and suppresses cancellation errors', async () => {
  vi.useFakeTimers()
  let opens = 0
  const follow: SessionFollow = async function* (_environment, _request, signal) {
    if (++opens === 1) throw new RemoteError('environment/session-unavailable', 'offline', {})
    yield base
    await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('reader cancelled')) }, { once: true }) })
  }
  const controller = fixture(follow)
  await vi.advanceTimersByTimeAsync(1000)
  expect(opens).toBe(2)
  expect(controller.state.getSnapshot().offline).toBe(false)
  await controller.dispose()
  expect(controller.state.getSnapshot().streamFailure).toBeUndefined()
})

it('waits for a configured interval and can restart after the first configuration lookup fails', async () => {
  const interval = vi.fn<() => Promise<number>>().mockRejectedValue(new Error('local host unavailable'))
  const follow = vi.fn<SessionFollow>(async function* () { yield base })
  const controller = new RemoteSessionController(call, interval, vi.fn(), follow)
  roots.push(controller); controller.open(workspace); controller.select(sessionId); controller.resume()
  await vi.waitFor(() => { expect(controller.state.getSnapshot().offline).toBe(true); expect(interval).toHaveBeenCalled() })
  interval.mockResolvedValue(1000)
  controller.reconnect()
  await vi.waitFor(() => { expect(follow).toHaveBeenCalledTimes(2) })
})

it('does not schedule another reader if paused while resolving retry configuration', async () => {
  let resolveInterval!: (value: number) => void
  const interval = () => new Promise<number>((resolve) => { resolveInterval = resolve })
  const follow: SessionFollow = async function* () { yield base }
  const controller = new RemoteSessionController(async () => { throw new Error('offline') }, interval, vi.fn(), follow)
  roots.push(controller); controller.open(workspace); controller.select(sessionId); controller.resume()
  await vi.waitFor(() => { expect(controller.state.getSnapshot().offline).toBe(true); expect(resolveInterval).toBeTypeOf('function') })
  controller.pause(); resolveInterval(1000)
  await controller.dispose()
  expect(controller.state.getSnapshot().offline).toBe(true)
})
