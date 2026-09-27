/** Dashboard polling retains coordinator ownership through switches and interrupted requests. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TeamController, type TeamCall } from '../src/client/team-controller.ts'
import type { TeamDashboardResult } from '../src/team-types.ts'
import type { EnvironmentTarget } from '../src/workspace-types.ts'

const first = brandString<EnvironmentTarget['environmentId']>('11111111-1111-4111-8111-111111111111')
const second = brandString<EnvironmentTarget['environmentId']>('22222222-2222-4222-8222-222222222222')
const targets: EnvironmentTarget[] = [{ environmentId: first, label: 'First', local: true, status: 'online' },
  { environmentId: second, label: 'Second', local: false, status: 'online' }]
const team: Extract<TeamDashboardResult, { kind: 'team' }> = { kind: 'team', environmentId: first,
  teamId: brandString<Extract<TeamDashboardResult, { kind: 'team' }>['teamId']>('team'), workspace: 'project', members: [], tasks: [], outbox: [] }
const catalog: Extract<TeamDashboardResult, { kind: 'catalog' }> = { kind: 'catalog', environmentId: first,
  teams: [{ teamId: team.teamId, workspace: 'project', members: 1, tasks: 0, queuedMessages: 0 }] }
const controllers: TeamController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())); vi.useRealTimers() })
function fixture(call: TeamCall) {
  const notify = vi.fn()
  const controller = new TeamController(call, async () => targets, async () => 1000, notify)
  controllers.push(controller)
  return { controller, notify }
}

it('polls only while visible and retains the last records through an outage', async () => {
  vi.useFakeTimers()
  let offline = false
  const call = vi.fn<TeamCall>(async (_environment, request) => {
    if (offline) throw new Error('offline')
    return request.action === 'catalog' ? catalog : team
  })
  const { controller } = fixture(call)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.selectTeam(team.teamId)
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.state.getSnapshot().detail).toEqual(team)
  offline = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(controller.state.getSnapshot()).toMatchObject({ detail: team, offline: true })
  offline = false
  await vi.advanceTimersByTimeAsync(1000)
  expect(controller.state.getSnapshot()).toMatchObject({ detail: team, offline: false })
  controller.pause()
  const count = call.mock.calls.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(call).toHaveBeenCalledTimes(count)
  expect(controller.state.getSnapshot().detail).toEqual(team)
})

it('ignores late records from a coordinator after a machine switch', async () => {
  vi.useFakeTimers()
  const held = Promise.withResolvers<TeamDashboardResult>()
  const call = vi.fn<TeamCall>(async environment => environment === first ? held.promise : { ...catalog, environmentId: second })
  const { controller } = fixture(call)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.selectEnvironment(second)
  await vi.advanceTimersByTimeAsync(0)
  held.resolve(catalog)
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.state.getSnapshot()).toMatchObject({ environmentId: second, catalog: { environmentId: second } })
  expect(call.mock.calls[0]![2].aborted).toBe(true)
})

it('sends interruption once and keeps destination errors visible through the shell notification', async () => {
  vi.useFakeTimers()
  const held = Promise.withResolvers<TeamDashboardResult>()
  const call = vi.fn<TeamCall>(async (_environment, request) => request.action === 'interrupt'
    ? held.promise : request.action === 'catalog' ? catalog : team)
  const { controller, notify } = fixture(call)
  controller.resume()
  await vi.advanceTimersByTimeAsync(0)
  controller.selectTeam(team.teamId)
  await vi.advanceTimersByTimeAsync(0)
  const sessionId = brandString<Extract<TeamDashboardResult, { kind: 'interrupted' }>['sessionId']>('member')
  const pending = controller.interrupt(sessionId)
  await controller.interrupt(sessionId)
  controller.refresh()
  expect(call.mock.calls.filter(([, request]) => request.action === 'interrupt')).toHaveLength(1)
  held.reject(new Error('lost confirmation'))
  await pending
  await vi.advanceTimersByTimeAsync(2000)
  expect(notify).toHaveBeenCalledWith(false)
  expect(call.mock.calls.filter(([, request]) => request.action === 'interrupt')).toHaveLength(1)
  expect(controller.state.getSnapshot().detail).toEqual(team)
  controller.pause()
  await controller.interrupt(sessionId)
  expect(call.mock.calls.filter(([, request]) => request.action === 'interrupt')).toHaveLength(1)
})
