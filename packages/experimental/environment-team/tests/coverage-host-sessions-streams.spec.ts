/** Terminal viewers, peer carriers and runtime dispatch for Session interactions and team dashboards. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EnvironmentSessionInteractions } from '../src/session-interactions.ts'
import { EnvironmentSessions } from '../src/session-service.ts'
import { EnvironmentTeams } from '../src/runtime.ts'
import { PeerTransport } from '../src/transport.ts'
import type { DistributedTeamId, OperationId } from '../src/protocol.ts'
import { terminalFrameStream } from '../src/terminal-stream.ts'
import type { EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from '../src/interaction-types.ts'
import { pairedSessionHosts } from './session-peer-host.ts'
import { sessionHost } from './session-host.ts'

const closes: (() => Promise<void>)[] = []
const aborts: AbortController[] = []
afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort()
  vi.restoreAllMocks()
  for (const close of closes.splice(0).reverse()) await close()
})
const signal = new AbortController().signal

const base: Omit<EnvironmentTerminalFrame, 'frame'> = {
  environmentId: brandString<EnvironmentTerminalFrame['environmentId']>('11111111-1111-4111-8111-111111111111'),
  workspaceId: brandString<EnvironmentTerminalFrame['workspaceId']>('workspace'),
  sessionId: brandString<EnvironmentTerminalFrame['sessionId']>('session'),
  terminalId: brandString<EnvironmentTerminalFrame['terminalId']>('terminal'),
}
const output = (sequence: number): EnvironmentTerminalFrame => ({ ...base, frame: { type: 'output', sequence, data: String(sequence) } })

it('ignores a source failure that follows cancellation by the owner', async () => {
  const abort = new AbortController()
  const started = Promise.withResolvers<undefined>()
  const stream = terminalFrameStream(async function* (lifetime) {
    started.resolve(undefined)
    await new Promise<void>((resolve) => { lifetime.addEventListener('abort', () => { resolve() }, { once: true }) })
    throw new Error('late failure')
  }, abort.signal, 1000)
  await started.promise
  abort.abort()
  await stream.done
  const received: EnvironmentTerminalFrame[] = []
  for await (const frame of stream.frames) received.push(frame)
  expect(received).toEqual([])
})

it('wraps a source failure that is not an Error', async () => {
  const failure: unknown = 'plain failure'
  const stream = terminalFrameStream(async function* () { yield output(1); throw failure }, new AbortController().signal, 1000)
  const iterator = stream.frames[Symbol.asyncIterator]()
  await iterator.next()
  await expect(iterator.next()).rejects.toMatchObject({ message: 'Terminal stream failed', cause: 'plain failure' })
})

it('delivers terminal state updates after the recovery baseline and rejects a baseline for another terminal', async () => {
  const { caller, destination } = await pairedSessionHosts((close) => { closes.push(close) })
  const request: EnvironmentTerminalFollowRequest = { workspaceId: destination.workspace.id, sessionId: SessionId(randomUUID()),
    terminalId: brandString<EnvironmentTerminalFollowRequest['terminalId']>('terminal'),
    attachmentId: brandString<EnvironmentTerminalFollowRequest['attachmentId']>('viewer') }
  const frameBase = { environmentId: destination.id, workspaceId: request.workspaceId,
    sessionId: request.sessionId, terminalId: request.terminalId }
  const info = (id: EnvironmentTerminalFollowRequest['terminalId']) => ({ id, title: 'Shell', cwd: destination.cwd, cols: 80, rows: 24,
    shell: { path: '/fixture/shell', args: [], name: 'Fixture shell' }, state: 'running', exitCode: null } as const)
  const snapshot: EnvironmentTerminalFrame = { ...frameBase, frame: { type: 'snapshot', sequence: 0, screen: 'screen', info: info(request.terminalId) } }
  const state: EnvironmentTerminalFrame = { ...frameBase, frame: { type: 'state', info: { ...info(request.terminalId), state: 'exited', exitCode: 0 } } }
  const next: EnvironmentTerminalFrame = { ...frameBase, frame: { type: 'output', sequence: 1, data: 'after exit' } }
  const foreign: EnvironmentTerminalFrame = { ...snapshot, frame: { type: 'snapshot', sequence: 0, screen: 'screen', info: info(brandString<EnvironmentTerminalFollowRequest['terminalId']>('another-terminal')) } }
  const source = vi.spyOn(EnvironmentSessionInteractions.prototype, 'followTerminal')
  const transport = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  source.mockImplementationOnce(async function* () { yield* [snapshot, state, next] })
  const accepted = new AbortController()
  aborts.push(accepted)
  const iterator = transport.terminalFollow(destination.id, request, accepted.signal)[Symbol.asyncIterator]()
  for (const frame of [snapshot, state, next]) expect((await iterator.next()).value).toEqual(frame)
  accepted.abort()
  await iterator.return?.()
  source.mockImplementationOnce(async function* () { yield foreign })
  const rejected = new AbortController()
  aborts.push(rejected)
  await expect(transport.terminalFollow(destination.id, request, rejected.signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
})

it('sends Session interactions to peers that advertise them and refuses peers that do not', async () => {
  const { caller, destination } = await pairedSessionHosts((close) => { closes.push(close) })
  const transport = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  const workspaceId = destination.workspace.id
  const sessionId = SessionId(randomUUID())
  await new EnvironmentSessions(destination.ctx, destination.id, destination.config).run(caller.id, { action: 'create', workspaceId, sessionId }, signal)
  const interaction = { kind: 'session-interaction', environmentId: destination.id, request: { action: 'snapshot', workspaceId, sessionId } } as const
  const dashboard = { kind: 'team-dashboard', environmentId: destination.id, request: { action: 'catalog' } } as const
  const descriptor = await transport.describe(destination.id, signal)
  expect(JSON.parse(await transport.call(destination.id, interaction, signal))).toMatchObject({ kind: 'snapshot', sessionId })
  const { workspaceSessionInteractions: _interactions, teamDashboard: _dashboard, ...legacyCapabilities } = descriptor.capabilities
  vi.spyOn(transport, 'describe').mockResolvedValue({ ...descriptor, capabilities: legacyCapabilities })
  const fetches = vi.spyOn(globalThis, 'fetch')
  await expect(transport.call(destination.id, interaction, signal)).rejects.toThrow('does not support session interactions')
  await expect(transport.call(destination.id, dashboard, signal)).rejects.toThrow('does not support team dashboard')
  expect(fetches).not.toHaveBeenCalled()
})

it('relays an interrupt for a member in this environment through its own runtime', async () => {
  const host = await sessionHost()
  closes.push(host.close)
  const call = vi.fn(async () => JSON.stringify({ status: 'inactive' }))
  const runtime = await EnvironmentTeams.open(host.ctx, host.id, host.config, call)
  closes.push(() => runtime.close())
  const handle = await host.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: host.cwd }, agentOptions: { provider: 'mock', model: 'mock' } })
  closes.push(() => handle.dispose())
  const operation = () => brandString<OperationId>(randomUUID())
  const teamId = brandString<DistributedTeamId>(handle.agent.id)
  await runtime.execute(handle.agent, operation(), { action: 'spawn', name: 'worker', environmentId: host.id, workspace: 'project', text: 'work' }, signal)
  const snapshot = await runtime.dashboard(host.id, { action: 'read', teamId }, signal)
  if (snapshot.kind !== 'team' || !snapshot.members[1]) throw new Error('Expected a team with a worker')
  const sessionId = snapshot.members[1].sessionId
  expect(snapshot.members[1].environmentId).toBe(host.id)
  await runtime.pump()
  expect(await runtime.dashboard(host.id, { action: 'interrupt', teamId, sessionId }, signal)).toMatchObject({ kind: 'interrupted', sessionId, status: 'interrupt-requested' })
  expect(call).not.toHaveBeenCalled()
  expect(JSON.parse(await runtime.receive(host.id, { kind: 'team-dashboard', environmentId: host.id, request: { action: 'catalog' } }))).toMatchObject({ kind: 'catalog', teams: [{ teamId }] })
})
