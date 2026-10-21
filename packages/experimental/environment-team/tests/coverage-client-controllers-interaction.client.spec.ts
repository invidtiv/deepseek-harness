/** Interaction controller read recovery, mutation acknowledgement and terminal attachment lifecycle. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteInteractionController, type InteractionCall, type TerminalFollow } from '../src/client/interaction-controller.ts'
import type { EnvironmentInteractionResult, EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from '../src/interaction-types.ts'

const address = {
  environmentId: brandString<EnvironmentInteractionResult['environmentId']>('11111111-1111-4111-8111-111111111111'),
  workspaceId: brandString<EnvironmentInteractionResult['workspaceId']>('workspace'),
  sessionId: brandString<EnvironmentInteractionResult['sessionId']>('session'),
}
const snapshot: Extract<EnvironmentInteractionResult, { kind: 'snapshot' }> = {
  ...address, kind: 'snapshot', pending: [], attachments: [], details: [], terminals: [],
  capabilities: { attachments: true, approvals: true, terminals: true },
  maxUploadBytes: 1024, terminalCols: 80, terminalRows: 24, truncated: false,
}
const terminalId = brandString<EnvironmentTerminalFollowRequest['terminalId']>('terminal')
const info = {
  id: terminalId, title: 'shell', shell: { path: '/bin/sh', args: [], name: 'sh' }, cwd: '/srv/project',
  cols: 80, rows: 24, state: 'running' as const, exitCode: null,
}
const controllers: RemoteInteractionController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(value => value.dispose())); vi.useRealTimers() })
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}
function fixture(call: InteractionCall, follow: TerminalFollow = async function* () {}, interval = async () => 1000) {
  const notify = vi.fn()
  const controller = new RemoteInteractionController(call, follow, interval, notify)
  controllers.push(controller)
  return { controller, notify }
}

it('reattaches the retained terminal on resume and never attaches without a selection or while paused', async () => {
  const follow = vi.fn<TerminalFollow>(async function* (_environment, _request, signal) { await untilAborted(signal) })
  const { controller } = fixture(async () => snapshot, follow)
  controller.connectTerminal(terminalId)
  expect(follow).not.toHaveBeenCalled()
  controller.select(address); controller.resume()
  controller.connectTerminal(terminalId)
  await vi.waitFor(() => { expect(follow).toHaveBeenCalledTimes(1) })
  controller.resume()
  expect(follow).toHaveBeenCalledTimes(1)
  controller.pause()
  controller.connectTerminal(terminalId)
  expect(follow).toHaveBeenCalledTimes(1)
  controller.resume()
  await vi.waitFor(() => { expect(follow).toHaveBeenCalledTimes(2) })
  expect(follow.mock.calls[1]![1].attachmentId).not.toBe(follow.mock.calls[0]![1].attachmentId)
})

it('marks the read offline when the destination answers with another result kind', async () => {
  const { controller } = fixture(async () => ({ ...address, kind: 'acknowledged' }))
  controller.select(address); controller.resume()
  await vi.waitFor(() => { expect(controller.state.getSnapshot()).toMatchObject({ loading: false, offline: true }) })
  expect(controller.state.getSnapshot().snapshot).toBeUndefined()
})

it('ignores a failed read from a superseded selection', async () => {
  const pending = Promise.withResolvers<EnvironmentInteractionResult>()
  const call = vi.fn<InteractionCall>().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot)
  const { controller } = fixture(call)
  controller.select(address); controller.resume()
  const other = { ...address, sessionId: brandString<EnvironmentInteractionResult['sessionId']>('other') }
  controller.select(other)
  pending.reject(new Error('late failure'))
  await vi.waitFor(() => { expect(controller.state.getSnapshot()).toMatchObject({ snapshot, offline: false }) })
  expect(controller.state.getSnapshot().address).toEqual(other)
})

it('does not poll until a refresh interval has been configured', async () => {
  vi.useFakeTimers()
  const call = vi.fn<InteractionCall>().mockResolvedValue(snapshot)
  const interval = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('unconfigured')).mockResolvedValue(1000)
  const { controller } = fixture(call, undefined, interval)
  controller.select(address); controller.resume()
  await vi.advanceTimersByTimeAsync(5000)
  expect(call).toHaveBeenCalledTimes(1)
  await controller.refresh()
  await vi.advanceTimersByTimeAsync(1000)
  expect(call).toHaveBeenCalledTimes(3)
})

it('returns acknowledged results and refreshes, but ignores a failure after the selection changed', async () => {
  const mutation = Promise.withResolvers<EnvironmentInteractionResult>()
  const call = vi.fn<InteractionCall>(async (_environment, request) => {
    if (request.action === 'terminal-close') return request.terminalId === terminalId ? { ...address, kind: 'acknowledged' } : mutation.promise
    return snapshot
  })
  const { controller, notify } = fixture(call)
  controller.select(address); controller.resume()
  expect(await controller.run({ action: 'terminal-close', terminalId })).toEqual({ ...address, kind: 'acknowledged' })
  expect(notify).toHaveBeenCalledExactlyOnceWith(true)
  expect(controller.state.getSnapshot().busy).toBe(false)
  const failing = controller.run({ action: 'terminal-close', terminalId: brandString<EnvironmentTerminalFollowRequest['terminalId']>('late') })
  controller.select({ ...address, sessionId: brandString<EnvironmentInteractionResult['sessionId']>('other') })
  mutation.reject(new Error('response lost'))
  expect(await failing).toBeUndefined()
  expect(notify).toHaveBeenCalledExactlyOnceWith(true)
})

it('skips an attachment replaced before its stream starts', async () => {
  const follow = vi.fn<TerminalFollow>(async function* (_environment, _request, signal) { await untilAborted(signal) })
  const { controller } = fixture(async () => snapshot, follow)
  controller.select(address); controller.resume()
  controller.connectTerminal(terminalId); controller.connectTerminal(terminalId)
  await vi.waitFor(() => { expect(follow).toHaveBeenCalledTimes(1) })
  await controller.dispose()
  expect(follow).toHaveBeenCalledTimes(1)
})

it('discards a frame that arrives after its attachment was stopped', async () => {
  const gate = Promise.withResolvers<undefined>()
  const follow = vi.fn<TerminalFollow>(async function* () {
    await gate.promise
    yield { ...address, terminalId, frame: { type: 'output', sequence: 1, data: 'late' } }
  })
  const { controller } = fixture(async () => snapshot, follow)
  controller.select(address); controller.resume()
  controller.connectTerminal(terminalId)
  await vi.waitFor(() => { expect(follow).toHaveBeenCalledOnce() })
  controller.pause()
  gate.resolve(undefined)
  await controller.dispose()
  expect(controller.state.getSnapshot()).toMatchObject({ terminalRevision: 0, terminalOffline: false })
  expect(controller.state.getSnapshot().terminalFrame).toBeUndefined()
})

it('records terminal metadata from state frames and reports an ended stream as offline', async () => {
  const frame: EnvironmentTerminalFrame = { ...address, terminalId, frame: { type: 'state', info } }
  const follow: TerminalFollow = async function* () { yield frame }
  const { controller } = fixture(async () => snapshot, follow)
  controller.select(address); controller.resume()
  controller.connectTerminal(terminalId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().terminalInfo).toEqual(info) })
  expect(controller.state.getSnapshot().terminalOffline).toBe(false)
  controller.rendered(controller.state.getSnapshot().terminalRevision)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().terminalOffline).toBe(true) })
})

it('reports a failed terminal stream as offline while retaining the last screen', async () => {
  const follow: TerminalFollow = async function* () {
    yield { ...address, terminalId, frame: { type: 'snapshot', sequence: 1, screen: 'prompt', info } }
    throw new Error('stream failed')
  }
  const { controller } = fixture(async () => snapshot, follow)
  controller.select(address); controller.resume()
  controller.connectTerminal(terminalId)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().terminalFrame).toBeDefined() })
  controller.rendered(controller.state.getSnapshot().terminalRevision)
  await vi.waitFor(() => { expect(controller.state.getSnapshot().terminalOffline).toBe(true) })
  expect(controller.state.getSnapshot().terminalFrame).toMatchObject({ frame: { screen: 'prompt' } })
})

it('does not report a terminal input failure that completes after the attachment was stopped', async () => {
  const input = Promise.withResolvers<EnvironmentInteractionResult>()
  const call = vi.fn<InteractionCall>(async (_environment, request) => request.action === 'terminal-write' ? input.promise : snapshot)
  const follow: TerminalFollow = async function* (_environment, _request, signal) { await untilAborted(signal) }
  const { controller, notify } = fixture(call, follow)
  controller.select(address); controller.resume()
  controller.connectTerminal(terminalId)
  controller.write('a')
  await vi.waitFor(() => { expect(call.mock.calls.some(([, request]) => request.action === 'terminal-write')).toBe(true) })
  controller.pause()
  input.reject(new Error('response lost'))
  await controller.dispose()
  expect(notify).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot().terminalOffline).toBe(false)
})
