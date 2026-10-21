// @vitest-environment jsdom
/** Destination session panel: catalog paging, history paging, draft attachments and send gating. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Sessions, SessionsIcon, type SessionsFace } from '../src/client/Sessions.tsx'
import type { RemoteSessionState } from '../src/client/session-controller.ts'
import type { InteractionState } from '../src/client/interaction-controller.ts'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)
const dictionary = { ...common, ...en }
const environmentId = brandString<NonNullable<RemoteSessionState['workspace']>['environmentId']>('11111111-1111-4111-8111-111111111111')
const workspaceId = brandString<NonNullable<RemoteSessionState['workspace']>['workspaceId']>('workspace')
const sessionId = brandString<NonNullable<RemoteSessionState['sessionId']>>('session')
const workspace = { environmentId, workspaceId, alias: 'project', relativePath: '', path: '/srv/project', title: 'Linux project' }
const idle: InteractionState = { loading: false, busy: false, offline: false, terminalOffline: false, terminalRevision: 0 }
const sessions = (truncated: boolean) => ({ environmentId, workspaceId, kind: 'sessions' as const, sessions: [], truncated })
const transcript = (overrides: Partial<NonNullable<RemoteSessionState['transcript']>> = {}): NonNullable<RemoteSessionState['transcript']> =>
  ({ environmentId, workspaceId, kind: 'snapshot', sessionId, cursor: 1, running: false, messages: [], truncated: false, ...overrides })

function mount(state: RemoteSessionState, interactions: InteractionState = idle) {
  const actions = {
    resume: vi.fn(), pause: vi.fn(), back: vi.fn(), refresh: vi.fn(), create: vi.fn(), select: vi.fn(),
    draft: vi.fn(), send: vi.fn(), cancel: vi.fn(), olderSessions: vi.fn(), backToLatestSessions: vi.fn(),
    earlier: vi.fn(), backToLive: vi.fn(), removeAttachment: vi.fn(), openWorkspace: vi.fn(),
    interaction: vi.fn(), upload: vi.fn(), download: vi.fn(), terminalConnect: vi.fn(),
    terminalCreate: vi.fn(), terminalWrite: vi.fn(), terminalRendered: vi.fn(),
  }
  const props: PropsLocale<'environmentTeams'> & InjectFace<SessionsFace> = {
    ...actions, t: key => dictionary[key],
    useRemoteSessions: selector => selector(state), useRemoteInteractions: selector => selector(interactions),
  }
  return { actions, props, ...render(<Sessions {...props} />) }
}
const base: RemoteSessionState = { loading: false, busy: false, offline: false, draft: '', uncertain: false }

it('renders the sidebar icon', () => {
  const { container } = render(<SessionsIcon />)
  expect(container.querySelector('svg')).toBeTruthy()
})

it('asks for a workspace and ignores a recent-workspace choice that no longer exists', () => {
  const { actions } = mount({ ...base, recentWorkspaces: [workspace] })
  expect(screen.getByText(en.selectRemoteWorkspace)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.newSession })).toHaveProperty('disabled', true)
  const selector = screen.getByRole('combobox', { name: en.recentRemoteWorkspaces })
  fireEvent.change(selector, { target: { value: 'absent' } })
  expect(actions.openWorkspace).not.toHaveBeenCalled()
})

it('pages older sessions and offers the latest page while one is loading', () => {
  const state: RemoteSessionState = { ...base, workspace, offline: true, list: sessions(true), catalogLoading: true }
  const { actions, rerender, props } = mount(state)
  expect(screen.getByRole('alert').textContent).toBe(en.sessionOffline)
  expect(screen.getByText(en.noRemoteSessions)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.olderSessions })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: en.recentSessions }))
  expect(actions.backToLatestSessions).toHaveBeenCalledOnce()
  state.catalogLoading = false
  rerender(<Sessions {...props} />)
  expect(screen.queryByRole('button', { name: en.recentSessions })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.olderSessions }))
  expect(actions.olderSessions).toHaveBeenCalledOnce()
  state.catalogHistory = sessions(false)
  rerender(<Sessions {...props} />)
  expect(screen.getByText(en.noOlderSessions)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.olderSessions })).toBeNull()
})

it('shows loading placeholders while the first catalog and transcript arrive', () => {
  const state: RemoteSessionState = { ...base, workspace, loading: true, sessionId }
  const { container, rerender, props } = mount(state)
  expect(container.querySelectorAll('svg')).toHaveLength(2)
  state.transcript = transcript()
  state.list = sessions(false)
  rerender(<Sessions {...props} />)
  expect(container.querySelectorAll('svg')).toHaveLength(0)
})

it('labels both roles, pages earlier messages and explains unsupported history', () => {
  const messages = [{ seq: 1, role: 'user' as const, text: 'Question' }, { seq: 2, role: 'assistant' as const, text: 'Answer' }]
  const state: RemoteSessionState = { ...base, workspace, sessionId, transcript: transcript({ messages, truncated: true }) }
  const { actions, rerender, props } = mount(state)
  expect(screen.getByText(en.sessionUser)).toBeTruthy()
  expect(screen.getByText(en.sessionAssistant)).toBeTruthy()
  expect(screen.getByText(en.messagesTruncated)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.earlierMessages }))
  expect(actions.earlier).toHaveBeenCalledOnce()
  state.historyUnsupported = true
  rerender(<Sessions {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en.historyUnsupported)
  expect(screen.getByRole('button', { name: en.earlierMessages })).toHaveProperty('disabled', true)
})

it('shows an empty earlier page and a loading page with a way back to the live conversation', () => {
  const state: RemoteSessionState = { ...base, workspace, sessionId, transcript: transcript(), historyLoading: true }
  const { container, actions, rerender, props } = mount(state)
  expect(container.querySelectorAll('svg')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: en.returnToLive }))
  expect(actions.backToLive).toHaveBeenCalledOnce()
  state.historyLoading = false
  state.history = transcript()
  rerender(<Sessions {...props} />)
  expect(screen.getByText(en.noEarlierMessages)).toBeTruthy()
  expect(screen.queryByText(en.messagesTruncated)).toBeNull()
})

it('removes staged attachments, sends attachment-only drafts and gates sending on busy state', () => {
  const state: RemoteSessionState = { ...base, workspace, sessionId, transcript: transcript({ running: true }), attachments: [{ name: 'notes.txt' }, { name: 'diagram.png' }] }
  const { actions, rerender, props } = mount(state)
  expect(screen.getByText('notes.txt')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: en.remove })[1]!)
  expect(actions.removeAttachment).toHaveBeenCalledExactlyOnceWith(1)
  const send = screen.getByRole('button', { name: en.sendMessage })
  expect(send).toHaveProperty('disabled', false)
  fireEvent.click(send)
  expect(actions.send).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.stopSession }))
  expect(actions.cancel).toHaveBeenCalledOnce()
  state.attachments = []
  rerender(<Sessions {...props} />)
  expect(screen.getByRole('button', { name: en.sendMessage })).toHaveProperty('disabled', true)
  delete state.attachments
  state.draft = '   '
  rerender(<Sessions {...props} />)
  expect(screen.getByRole('button', { name: en.sendMessage })).toHaveProperty('disabled', true)
  state.draft = 'Continue'
  rerender(<Sessions {...props} />)
  expect(screen.getByRole('button', { name: en.sendMessage })).toHaveProperty('disabled', false)
})

it('blocks sending while the destination interaction is busy and stopping when no turn runs', () => {
  const { container } = mount({ ...base, workspace, sessionId, draft: 'Continue', transcript: transcript() }, { ...idle, busy: true })
  expect(screen.getByRole('button', { name: en.sendMessage })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.stopSession })).toHaveProperty('disabled', true)
  expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('false')
})

it('freezes attachments and the composer while a message is unconfirmed', () => {
  mount({ ...base, workspace, sessionId, draft: 'Unconfirmed', uncertain: true, transcript: transcript(), attachments: [{ name: 'notes.txt' }] })
  expect(screen.getByRole('alert').textContent).toBe(en.sessionUncertain)
  expect(screen.getByRole('button', { name: en.remove })).toHaveProperty('disabled', true)
})

it('marks the panel busy while the destination catalog loads', () => {
  const { container } = mount({ ...base, workspace, loading: true })
  expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
})
