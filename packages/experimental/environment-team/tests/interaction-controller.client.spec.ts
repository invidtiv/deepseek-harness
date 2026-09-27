/** Destination isolation, pending operation ownership and ordered terminal backpressure. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteInteractionController, type InteractionCall, type TerminalFollow } from '../src/client/interaction-controller.ts'
import type { EnvironmentInteractionResult, EnvironmentTerminalFollowRequest } from '../src/interaction-types.ts'

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
const controllers: RemoteInteractionController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(value => value.dispose())); vi.useRealTimers() })
function fixture(call: InteractionCall = async () => snapshot, follow: TerminalFollow = async function* () {}) {
  const notify = vi.fn()
  const controller = new RemoteInteractionController(call, follow, async () => 1000, notify)
  controllers.push(controller); controller.select(address); controller.resume()
  return { controller, notify }
}

it('retains data during an outage and recovers on the configured interval', async () => {
  vi.useFakeTimers()
  const call = vi.fn<InteractionCall>().mockResolvedValue(snapshot)
  const { controller } = fixture(call)
  await vi.advanceTimersByTimeAsync(0)
  call.mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(controller.state.getSnapshot()).toMatchObject({ snapshot, offline: true })
  await vi.advanceTimersByTimeAsync(1000)
  expect(controller.state.getSnapshot().offline).toBe(false)
})

it('rejects late reads and mutation acknowledgments after the selected machine changes', async () => {
  const pending = Promise.withResolvers<EnvironmentInteractionResult>()
  const call = vi.fn<InteractionCall>().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot)
  const { controller, notify } = fixture(call)
  const mutation = Promise.withResolvers<EnvironmentInteractionResult>()
  call.mockReturnValueOnce(mutation.promise)
  const operation = controller.run({ action: 'terminal-close', terminalId })
  expect(await controller.run({ action: 'terminal-close', terminalId })).toBeUndefined()
  controller.select({ ...address, environmentId: brandString<EnvironmentInteractionResult['environmentId']>('other') })
  mutation.resolve({ ...address, kind: 'acknowledged' }); pending.resolve(snapshot)
  expect(await operation).toBeUndefined()
  expect(notify).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot().address?.environmentId).toBe('other')
})

it('does not repeat an ambiguous mutation and clears pending state on pause', async () => {
  const call = vi.fn<InteractionCall>(async (_environment, request) => {
    if (request.action !== 'snapshot') throw new Error('response lost')
    return snapshot
  })
  const { controller, notify } = fixture(call)
  await controller.run({ action: 'terminal-close', terminalId })
  expect(notify).toHaveBeenCalledWith(false)
  expect(call.mock.calls.filter(([, request]) => request.action === 'terminal-close')).toHaveLength(1)
  controller.pause(); expect(controller.state.getSnapshot().busy).toBe(false)
  controller.select(); expect(await controller.run({ action: 'terminal-close', terminalId })).toBeUndefined()
})

it('waits for rendered terminal output and serializes keyboard input without replay after uncertainty', async () => {
  let reads = 0
  const follow: TerminalFollow = async function* (_environment, _request, signal) {
    for (const data of ['one', 'two']) { reads++; yield { ...address, terminalId, frame: { type: 'output', sequence: reads, data } } }
    if (signal.aborted) return
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }
  const first = Promise.withResolvers<EnvironmentInteractionResult>()
  const call = vi.fn<InteractionCall>(async (_environment, request) => {
    if (request.action === 'terminal-write') return request.data === 'a' ? first.promise : { ...address, kind: 'acknowledged' }
    return snapshot
  })
  const { controller } = fixture(call, follow)
  controller.connectTerminal(terminalId)
  await vi.waitFor(() => { expect(reads).toBe(1) })
  controller.rendered(0); expect(reads).toBe(1)
  controller.rendered(controller.state.getSnapshot().terminalRevision)
  await vi.waitFor(() => { expect(reads).toBe(2) })
  controller.write('a'); controller.write('b')
  await vi.waitFor(() => { expect(call.mock.calls.filter(([, request]) => request.action === 'terminal-write')).toHaveLength(1) })
  first.reject(new Error('unknown acceptance'))
  await vi.waitFor(() => { expect(controller.state.getSnapshot().terminalOffline).toBe(true) })
  expect(call.mock.calls.filter(([, request]) => request.action === 'terminal-write')).toHaveLength(1)
  controller.write('c'); controller.pause()
})
