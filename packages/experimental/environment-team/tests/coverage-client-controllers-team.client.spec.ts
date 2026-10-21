/** Team dashboard selection while hidden, interruption outcomes, empty roster and malformed coordinator replies. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TeamController, type TeamCall } from '../src/client/team-controller.ts'
import type { TeamDashboardResult } from '../src/team-types.ts'
import type { EnvironmentTarget } from '../src/workspace-types.ts'

const first = brandString<EnvironmentTarget['environmentId']>('11111111-1111-4111-8111-111111111111')
const targets: EnvironmentTarget[] = [{ environmentId: first, label: 'First', local: true, status: 'online' }]
const team: Extract<TeamDashboardResult, { kind: 'team' }> = { kind: 'team', environmentId: first,
  teamId: brandString<Extract<TeamDashboardResult, { kind: 'team' }>['teamId']>('team'), workspace: 'project', members: [], tasks: [], outbox: [] }
const catalog: Extract<TeamDashboardResult, { kind: 'catalog' }> = { kind: 'catalog', environmentId: first,
  teams: [{ teamId: team.teamId, workspace: 'project', members: 1, tasks: 0, queuedMessages: 0 }] }
const member = brandString<Extract<TeamDashboardResult, { kind: 'interrupted' }>['sessionId']>('member')
const interrupted: TeamDashboardResult = { kind: 'interrupted', environmentId: first, teamId: team.teamId, sessionId: member, status: 'interrupt-requested' }
const controllers: TeamController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())); vi.useRealTimers() })
function fixture(
  call: TeamCall, environments: () => Promise<EnvironmentTarget[]> = async () => targets,
  interval: () => Promise<number> = async () => 1000,
) {
  const notify = vi.fn()
  const controller = new TeamController(call, environments, interval, notify)
  controllers.push(controller)
  return { controller, notify }
}
const dashboard: TeamCall = async (_environment, request) => request.action === 'catalog' ? catalog : team

it('records a selection made while hidden and reads it on resume', async () => {
  vi.useFakeTimers()
  const call = vi.fn<TeamCall>(dashboard)
  const { controller } = fixture(call)
  controller.selectEnvironment(first)
  controller.selectTeam(team.teamId)
  expect(call).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot()).toMatchObject({ environmentId: first, teamId: team.teamId })
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.state.getSnapshot().detail).toEqual(team)
})

it('acknowledges an interruption and refreshes the roster', async () => {
  vi.useFakeTimers()
  const call = vi.fn<TeamCall>(async (environment, request, signal) => request.action === 'interrupt'
    ? interrupted : dashboard(environment, request, signal))
  const { controller, notify } = fixture(call)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.selectTeam(team.teamId)
  await vi.advanceTimersByTimeAsync(0)
  const reads = call.mock.calls.length
  await controller.interrupt(member)
  expect(notify).toHaveBeenCalledExactlyOnceWith(true)
  expect(controller.state.getSnapshot().busy).toBe(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(call.mock.calls.length).toBeGreaterThan(reads + 1)
})

it('leaves busy cleanup to the newer operation when a selection supersedes an interruption', async () => {
  vi.useFakeTimers()
  const held = Promise.withResolvers<TeamDashboardResult>()
  const call = vi.fn<TeamCall>(async (environment, request, signal) => request.action === 'interrupt' ? held.promise : dashboard(environment, request, signal))
  const { controller, notify } = fixture(call)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.selectTeam(team.teamId)
  await vi.advanceTimersByTimeAsync(0)
  const pending = controller.interrupt(member)
  expect(controller.state.getSnapshot().busy).toBe(true)
  controller.selectEnvironment(first)
  held.resolve(interrupted)
  await pending
  expect(notify).toHaveBeenCalledExactlyOnceWith(true)
  expect(controller.state.getSnapshot().busy).toBe(false)
})

it('shows an empty roster without selecting a coordinator', async () => {
  vi.useFakeTimers()
  const call = vi.fn<TeamCall>(dashboard)
  const { controller } = fixture(call, async () => [])
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  expect(call).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot()).toMatchObject({ targets: [], offline: false, loading: false })
  expect(controller.state.getSnapshot().environmentId).toBeUndefined()
})

it('does not poll until the first read has resolved its refresh interval', async () => {
  vi.useFakeTimers()
  const call = vi.fn<TeamCall>(dashboard)
  const { controller } = fixture(call, async () => { throw new Error('offline') })
  controller.resume()
  await vi.advanceTimersByTimeAsync(5000)
  expect(call).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot()).toMatchObject({ offline: true, loading: false })
})

it.each([
  ['catalog', { action: 'catalog' }],
  ['detail', { action: 'read' }],
] as const)('reports a malformed %s reply as offline and keeps earlier records', async (_name, malformed) => {
  vi.useFakeTimers()
  let broken = false
  const call = vi.fn<TeamCall>(async (environment, request, signal) => {
    if (broken && request.action === malformed.action) return interrupted
    return dashboard(environment, request, signal)
  })
  const { controller } = fixture(call)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.selectTeam(team.teamId)
  await vi.advanceTimersByTimeAsync(0)
  broken = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(controller.state.getSnapshot()).toMatchObject({ offline: true, catalog, detail: team })
})

it.each(['environments', 'catalog', 'detail', 'failure'] as const)('discards a read answered after the panel was paused (%s)', async (stage) => {
  vi.useFakeTimers()
  const heldTargets = Promise.withResolvers<EnvironmentTarget[]>()
  const heldResult = Promise.withResolvers<TeamDashboardResult>()
  const call = vi.fn<TeamCall>(async (environment, request, signal) => {
    const held = stage === 'catalog' || stage === 'failure' ? 'catalog' : 'read'
    return stage !== 'environments' && request.action === held ? heldResult.promise : dashboard(environment, request, signal)
  })
  const { controller } = fixture(call, async () => stage === 'environments' ? heldTargets.promise : targets)
  controller.selectTeam(team.teamId)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.pause()
  if (stage === 'failure') heldResult.reject(new Error('late failure'))
  else if (stage === 'environments') heldTargets.resolve(targets)
  else heldResult.resolve(stage === 'catalog' ? catalog : team)
  await vi.advanceTimersByTimeAsync(5000)
  expect(controller.state.getSnapshot()).toMatchObject({ offline: false, loading: false })
  expect(controller.state.getSnapshot().detail).toBeUndefined()
  if (stage === 'environments') expect(call).not.toHaveBeenCalled()
})

it('releases a tracked interruption whose feedback callback throws', async () => {
  vi.useFakeTimers()
  const controller = new TeamController(dashboard, async () => targets, async () => 1000, () => { throw new Error('feedback failed') })
  controllers.push(controller)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.selectTeam(team.teamId)
  await vi.advanceTimersByTimeAsync(0)
  await expect(controller.interrupt(member)).rejects.toThrow('feedback failed')
  await expect(controller.dispose()).resolves.toBeUndefined()
})
