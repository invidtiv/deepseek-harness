// @vitest-environment jsdom
/** Team dashboard target selection, empty states and task status labels. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Teams, TeamsIcon, type TeamsFace } from '../src/client/Teams.tsx'
import type { TeamState } from '../src/client/team-controller.ts'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)
const dictionary = { ...common, ...en }
type Detail = NonNullable<TeamState['detail']>
const environmentId = brandString<NonNullable<TeamState['environmentId']>>('11111111-1111-4111-8111-111111111111')
const peerId = brandString<NonNullable<TeamState['environmentId']>>('22222222-2222-4222-8222-222222222222')
const teamId = brandString<NonNullable<TeamState['teamId']>>('team-build')
const otherTeamId = brandString<NonNullable<TeamState['teamId']>>('team-docs')
const task = (id: string, status: Detail['tasks'][number]['status'], owner?: string): Detail['tasks'][number] =>
  ({ id: brandString<Detail['tasks'][number]['id']>(id), text: `Task ${id}`, status, revision: 1, ...owner ? { owner } : {} })

function mount(state: TeamState) {
  const actions = { resume: vi.fn(), pause: vi.fn(), refresh: vi.fn(), selectEnvironment: vi.fn(), selectTeam: vi.fn(), interrupt: vi.fn() }
  const props: PropsLocale<'environmentTeams'> & InjectFace<TeamsFace> = { ...actions, t: key => dictionary[key], useRemoteTeams: selector => selector(state) }
  return { actions, props, ...render(<Teams {...props} />) }
}

it('renders the sidebar icon at the requested size', () => {
  const { container } = render(<TeamsIcon size={20} />)
  expect(container.querySelector('svg')).toBeTruthy()
})

it('labels local and remote machines and ignores a selection that no longer exists', () => {
  const state: TeamState = { targets: [
    { environmentId, label: 'Workstation', local: true, status: 'online' }, { environmentId: peerId, label: 'Builder', local: false, status: 'unsupported' },
  ], loading: true, busy: false, offline: false }
  const { actions } = mount(state)
  expect(Array.from(screen.getByLabelText(en.machine).querySelectorAll('option'), option => option.textContent)).toEqual([
    `Workstation · ${en.thisMachine}`, `Builder · ${en.unsupported}`,
  ])
  expect(screen.getByLabelText(en.machine)).toHaveProperty('value', environmentId)
  fireEvent.change(screen.getByLabelText(en.machine), { target: { value: 'absent' } })
  expect(actions.selectEnvironment).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: en.teamCatalog }).parentElement?.querySelectorAll('svg')).toHaveLength(1)
})

it('shows an empty catalog, then marks only the opened team', () => {
  const state: TeamState = { targets: [], environmentId, loading: false, busy: false, offline: false,
    catalog: { kind: 'catalog', environmentId, teams: [] } }
  const { rerender, props } = mount(state)
  expect(screen.getByText(en.noDistributedTeams)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  state.teamId = teamId
  state.catalog = { kind: 'catalog', environmentId, teams: [
    { teamId, workspace: 'project', members: 1, tasks: 0, queuedMessages: 0 }, { teamId: otherTeamId, workspace: 'docs', members: 1, tasks: 0, queuedMessages: 0 },
  ] }
  rerender(<Teams {...props} />)
  expect(screen.getAllByRole('button', { name: en.openTeam }).map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  expect(screen.queryByText(en.noDistributedTeams)).toBeNull()
})

it('reports empty tasks and deliveries and keeps the coordinator uninterruptible', () => {
  const lead = brandString<Detail['members'][number]['sessionId']>('lead-session')
  const state: TeamState = { targets: [], environmentId, teamId, loading: false, busy: false, offline: false,
    detail: { kind: 'team', environmentId, teamId, workspace: 'project', members: [{ environmentId, sessionId: lead, name: 'lead', workspace: 'project' }], tasks: [], outbox: [] } }
  mount(state)
  expect(screen.getByText(en.teamNoTasks)).toBeTruthy()
  expect(screen.getByText(en.teamNoDeliveries)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.teamInterrupt })).toBeNull()
})

it('labels every task status and shows an owner only when one is assigned', () => {
  const state: TeamState = { targets: [], environmentId, teamId, loading: false, busy: false, offline: false,
    detail: { kind: 'team', environmentId, teamId, workspace: 'project', members: [], outbox: [],
      tasks: [task('a', 'pending'), task('b', 'in_progress', 'builder'), task('c', 'completed')] } }
  mount(state)
  expect(screen.getByText(`${en.teamPending} · ${en.teamRevision}: 1`)).toBeTruthy()
  expect(screen.getByText(`${en.teamInProgress} · ${en.teamRevision}: 1`)).toBeTruthy()
  expect(screen.getByText(`${en.teamCompleted} · ${en.teamRevision}: 1`)).toBeTruthy()
  expect(screen.getAllByText(new RegExp(`^${en.teamOwner}:`))).toHaveLength(1)
})
