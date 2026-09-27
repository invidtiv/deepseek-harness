// @vitest-environment jsdom
/** Remote saved-message presentation and destination action controls. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Sessions, type SessionsFace } from '../src/client/Sessions.tsx'
import type { RemoteSessionState } from '../src/client/session-controller.ts'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)
const dictionary = { ...common, ...en }
const tools = {
  useRemoteInteractions: <T,>(select: (state: import('../src/client/interaction-controller.ts').InteractionState) => T): T => select({ loading: false, busy: false, offline: false, terminalOffline: false, terminalRevision: 0 }),
  interaction: vi.fn(),
  upload: vi.fn(), download: vi.fn(), terminalConnect: vi.fn(), terminalCreate: vi.fn(), terminalWrite: vi.fn(), terminalRendered: vi.fn(),
  removeAttachment: vi.fn(),
}
const environmentId = brandString<NonNullable<RemoteSessionState['workspace']>['environmentId']>('11111111-1111-4111-8111-111111111111')
const workspaceId = brandString<NonNullable<RemoteSessionState['workspace']>['workspaceId']>('workspace')
const sessionId = brandString<NonNullable<RemoteSessionState['sessionId']>>('session')
const attemptId = brandString<NonNullable<NonNullable<RemoteSessionState['transcript']>['live']>['attemptId']>('attempt')

it('renders destination text, keeps failure data and routes every action through injected callbacks', async () => {
  const state: RemoteSessionState = {
    workspace: { environmentId, workspaceId, alias: 'project', relativePath: '', path: '/srv/project', title: 'Linux project' },
    sessionId, loading: false, busy: false, offline: true, draft: 'Continue', uncertain: false,
    list: { environmentId, workspaceId, kind: 'sessions', sessions: [{ sessionId, title: 'Shared session', running: true, updatedAt: 1 }], truncated: true },
    transcript: { environmentId, workspaceId, kind: 'snapshot', sessionId, cursor: 2, running: true, messages: [{ seq: 1, role: 'user', text: 'Hello' }, { seq: 2, role: 'assistant', text: '<script>plain text</script>' }], truncated: true },
  }
  const actions = {
    resume: vi.fn(), pause: vi.fn(), back: vi.fn(), refresh: vi.fn(), create: vi.fn(),
    select: vi.fn(), draft: vi.fn(), send: vi.fn(), cancel: vi.fn(),
  }
  const props: PropsLocale<'environmentTeams'> & InjectFace<SessionsFace> = { ...tools, ...actions, ...tools, t: key => dictionary[key], useRemoteSessions: selector => selector(state) }
  const result = render(<Sessions {...props} />)
  expect(actions.resume).toHaveBeenCalledOnce()
  expect(screen.getByText('<script>plain text</script>')).toBeTruthy()
  expect(result.container.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.openSession })); expect(actions.select).toHaveBeenCalledWith(sessionId)
  fireEvent.change(screen.getByLabelText(en.sessionMessage), { target: { value: 'Changed' } }); expect(actions.draft).toHaveBeenCalledWith('Changed')
  for (const [label, action] of [
    [en.allWorkspaces, actions.back], [en.refresh, actions.refresh], [en.newSession, actions.create],
    [en.sendMessage, actions.send], [en.stopSession, actions.cancel],
  ] as const) {
    fireEvent.click(screen.getByRole('button', { name: label })); expect(action).toHaveBeenCalledOnce()
  }
  await expect(result.container.textContent).toMatchFileSnapshot('./expected/remote-session.txt')
  result.unmount(); expect(actions.pause).toHaveBeenCalledOnce()
})

it('keeps an unconfirmed message immutable and offers an explicit retry', () => {
  const state: RemoteSessionState = {
    sessionId, loading: false, busy: false, offline: false, draft: 'Unconfirmed', uncertain: true,
  }
  const send = vi.fn()
  render(<Sessions {...tools} t={key => dictionary[key]} useRemoteSessions={selector => selector(state)}
    resume={vi.fn()} pause={vi.fn()} back={vi.fn()} refresh={vi.fn()} create={vi.fn()}
    select={vi.fn()} draft={vi.fn()} send={send} cancel={vi.fn()} />)
  expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.retryMessage })); expect(send).toHaveBeenCalledOnce()
})

it('shows first-load, empty-session and destination-app states as snapshots arrive', () => {
  const state: RemoteSessionState = { loading: true, busy: false, offline: false, draft: '', uncertain: false }
  const props: PropsLocale<'environmentTeams'> & InjectFace<SessionsFace> = {
    ...tools, t: key => dictionary[key], useRemoteSessions: selector => selector(state),
    resume: vi.fn(), pause: vi.fn(), back: vi.fn(), refresh: vi.fn(), create: vi.fn(),
    select: vi.fn(), draft: vi.fn(), send: vi.fn(), cancel: vi.fn(),
  }
  const result = render(<Sessions {...props} />)
  expect(screen.getByRole('heading', { name: en.remoteSessions })).toBeTruthy()
  state.list = { environmentId, workspaceId, kind: 'sessions', sessions: [], truncated: false }
  state.webUrl = 'https://destination.example.ts.net'
  state.sessionId = sessionId
  result.rerender(<Sessions {...props} />)
  expect(screen.getByText(en.noRemoteSessions)).toBeTruthy()
  expect(screen.getByRole('link', { name: en.openDestination }).getAttribute('href')).toBe(state.webUrl)
  state.list = { ...state.list, sessions: [{ sessionId, title: 'Idle session', running: false, updatedAt: 1 }] }
  state.transcript = { environmentId, workspaceId, kind: 'snapshot', sessionId, cursor: 0, running: false, messages: [], truncated: false }
  result.rerender(<Sessions {...props} />)
  expect(screen.getByText(en.sessionIdle)).toBeTruthy()
  expect(screen.getByText(en.noSessionMessages)).toBeTruthy()
})

it('renders a live prefix and then replaces it with one saved assistant message', async () => {
  const state: RemoteSessionState = {
    sessionId, loading: false, busy: false, offline: false, draft: '', uncertain: false,
    transcript: { environmentId, workspaceId, kind: 'snapshot', sessionId, cursor: 0, running: true, messages: [], truncated: false, live: { attemptId, text: 'Working on the remote machine' } },
  }
  const props: PropsLocale<'environmentTeams'> & InjectFace<SessionsFace> = {
    ...tools, t: key => dictionary[key], useRemoteSessions: selector => selector(state),
    resume: vi.fn(), pause: vi.fn(), back: vi.fn(), refresh: vi.fn(), create: vi.fn(),
    select: vi.fn(), draft: vi.fn(), send: vi.fn(), cancel: vi.fn(),
  }
  const result = render(<Sessions {...props} />)
  expect(screen.getByText('Working on the remote machine')).toBeTruthy()
  const partial = result.container.textContent
  state.transcript = { environmentId, workspaceId, kind: 'snapshot', sessionId, cursor: 1, running: false, messages: [{ seq: 1, role: 'assistant', text: 'Working on the remote machine completed' }], truncated: false }
  result.rerender(<Sessions {...props} />)
  expect(screen.queryByText('Working on the remote machine')).toBeNull()
  expect(screen.getAllByText('Working on the remote machine completed')).toHaveLength(1)
  await expect(`${partial}\n\n${result.container.textContent}`).toMatchFileSnapshot('./expected/remote-session-live.txt')
  state.streamFailure = 'sessionDenied'
  result.rerender(<Sessions {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en.sessionDenied)
})
