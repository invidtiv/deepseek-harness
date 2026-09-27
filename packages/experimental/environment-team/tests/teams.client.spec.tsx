// @vitest-environment jsdom
/** Operator team dashboard renders only destination data and delegates explicit actions. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Teams, type TeamsFace } from '../src/client/Teams.tsx'
import type { TeamState } from '../src/client/team-controller.ts'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)
const dictionary = { ...common, ...en }
const environmentId = brandString<NonNullable<TeamState['environmentId']>>('11111111-1111-4111-8111-111111111111')
const teamId = brandString<NonNullable<TeamState['teamId']>>('team-build')
const sessionId = brandString<NonNullable<TeamState['detail']>['members'][number]['sessionId']>('worker-session')

it('shows coordinator roster, task revisions and delivery metadata while retaining offline data', async () => {
  const state: TeamState = { targets: [{ environmentId, label: 'Linux coordinator', local: false, status: 'online' }],
    environmentId, teamId, loading: false, busy: false, offline: true,
    catalog: { kind: 'catalog', environmentId, teams: [{ teamId, workspace: 'project', members: 2, tasks: 1, queuedMessages: 1 }] },
    detail: { kind: 'team', environmentId, teamId, workspace: 'project', members: [
      { environmentId, sessionId: brandString<typeof sessionId>('lead-session'), name: 'lead', workspace: 'project' },
      { environmentId, sessionId, name: 'builder', workspace: 'project' },
    ], tasks: [{ id: brandString<NonNullable<TeamState['detail']>['tasks'][number]['id']>('task-build'),
      text: '<script>build result</script>', revision: 2, status: 'in_progress', owner: 'builder' }],
    outbox: [{ id: brandString<NonNullable<TeamState['detail']>['outbox'][number]['id']>('delivery-build'), sender: 'lead', target: 'builder' }] },
  }
  const actions = { resume: vi.fn(), pause: vi.fn(), refresh: vi.fn(), selectEnvironment: vi.fn(), selectTeam: vi.fn(), interrupt: vi.fn() }
  const props: PropsLocale<'environmentTeams'> & InjectFace<TeamsFace> = {
    ...actions, t: key => dictionary[key], useRemoteTeams: selector => selector(state),
  }
  const rendered = render(<Teams {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en.teamReadFailed)
  expect(screen.getByText('<script>build result</script>')).toBeTruthy()
  expect(rendered.container.querySelector('script')).toBeNull()
  expect(screen.getAllByRole('button', { name: en.teamInterrupt })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: en.teamInterrupt }))
  expect(actions.interrupt).toHaveBeenCalledWith(sessionId)
  fireEvent.click(screen.getByRole('button', { name: en.openTeam }))
  expect(actions.selectTeam).toHaveBeenCalledWith(teamId)
  fireEvent.change(screen.getByLabelText(en.machine), { target: { value: environmentId } })
  expect(actions.selectEnvironment).toHaveBeenCalledWith(environmentId)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  expect(actions.refresh).toHaveBeenCalledOnce()
  await expect(rendered.container.textContent).toMatchFileSnapshot('./expected/remote-team-dashboard.txt')
  rendered.unmount()
  expect(actions.resume).toHaveBeenCalledOnce()
  expect(actions.pause).toHaveBeenCalledOnce()
})
