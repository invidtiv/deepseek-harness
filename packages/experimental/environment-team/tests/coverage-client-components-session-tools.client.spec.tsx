// @vitest-environment jsdom
/** Destination request routing, attachment gating and terminal controller state in the conversation accessories. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionTools, type SessionToolsActions } from '../src/client/SessionTools.tsx'
import type { RemoteTerminalProps } from '../src/client/RemoteTerminal.tsx'
import type { InteractionState } from '../src/client/interaction-controller.ts'
import type { EnvironmentPendingInteraction } from '../src/interaction-types.ts'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

const terminalProps = vi.hoisted(() => ({ latest: undefined as RemoteTerminalProps | undefined }))
vi.mock('../src/client/RemoteTerminal.tsx', () => ({
  RemoteTerminal: (props: RemoteTerminalProps) => { terminalProps.latest = props; return <div data-testid="terminal" /> },
}))
afterEach(() => { cleanup(); terminalProps.latest = undefined })

const dictionary = { ...common, ...en }
const t = (key: keyof typeof dictionary) => dictionary[key]
type Snapshot = NonNullable<InteractionState['snapshot']>
type Address = NonNullable<InteractionState['address']>
type Terminal = NonNullable<InteractionState['terminal']>
const address: Address = {
  environmentId: brandString<Address['environmentId']>('remote'), workspaceId: brandString<Address['workspaceId']>('workspace'),
  sessionId: brandString<Address['sessionId']>('session'),
}
const terminalId = brandString<Snapshot['terminals'][number]['id']>('terminal')
const attachmentId = brandString<Terminal['attachmentId']>('attachment')
const otherAttachmentId = brandString<Terminal['attachmentId']>('other')
const shell = { path: '/bin/sh', args: [], name: 'sh' }

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ...address, kind: 'snapshot', pending: [], attachments: [], details: [], terminals: [],
    capabilities: { attachments: true, approvals: true, terminals: true },
    maxUploadBytes: 1000, terminalCols: 100, terminalRows: 30, truncated: false, ...overrides,
  }
}
function state(overrides: Partial<InteractionState> = {}): InteractionState {
  return { loading: false, busy: false, offline: false, terminalOffline: false, terminalRevision: 0, ...overrides }
}
function tools(calls: SessionToolsActions, value: InteractionState, disabled = false) {
  return <SessionTools {...calls} state={value} disabled={disabled} t={t} />
}
function actions(): SessionToolsActions {
  return { interaction: vi.fn(), upload: vi.fn(), download: vi.fn(), terminalConnect: vi.fn(),
    terminalCreate: vi.fn(), terminalWrite: vi.fn(), terminalRendered: vi.fn() }
}

it('shows only the offline notice before the first destination snapshot', () => {
  render(<SessionTools {...actions()} state={state({ offline: true })} disabled={false} t={t} />)
  expect(screen.getByRole('alert').textContent).toBe(en.interactionOffline)
  expect(screen.queryByText(en.attachmentsDisabled)).toBeNull()
  expect(screen.queryByText(en.remoteTerminals)).toBeNull()
})

it('addresses pending approvals and answers to the destination request that issued them', () => {
  const approval = brandString<EnvironmentPendingInteraction['id']>('approval')
  const question = brandString<EnvironmentPendingInteraction['id']>('question')
  const pending: EnvironmentPendingInteraction[] = [
    { kind: 'approval', id: approval, toolName: 'bash' },
    { kind: 'questions', id: question, questions: [{ id: 'plan', question: 'Continue?', options: [{ label: 'Proceed' }] }] },
  ]
  const calls = actions()
  render(<SessionTools {...calls} state={state({ snapshot: snapshot({ pending }) })} disabled={false} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.rejectRequest }))
  expect(calls.interaction).toHaveBeenLastCalledWith({ action: 'approval', id: approval, decision: 'rejected' })
  fireEvent.click(screen.getByLabelText('Proceed'))
  fireEvent.click(screen.getByRole('button', { name: en.submitAnswer }))
  expect(calls.interaction).toHaveBeenLastCalledWith({ action: 'answer', id: question, answer: { answers: [{ id: 'plan', selected: ['Proceed'], custom: '' }] } })
})

it('explains disabled attachments, lists non-error tool details and flags truncation', () => {
  const details = [
    { seq: 1, kind: 'tool-call' as const, title: 'bash', text: 'ls', isError: false },
    { seq: 2, kind: 'error' as const, title: 'failure', text: 'denied', isError: true },
  ]
  const calls = actions()
  const capabilities = { attachments: false, approvals: true, terminals: false }
  render(tools(calls, state({ snapshot: snapshot({ details, truncated: true, capabilities }) })))
  expect(screen.getByText(en.attachmentsDisabled)).toBeTruthy()
  expect(screen.queryByLabelText(en.attachFile)).toBeNull()
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByText('ls')).toBeTruthy()
  expect(screen.getByText(en.detailsTruncated)).toBeTruthy()
  expect(screen.queryByText(en.remoteTerminals)).toBeNull()
})

it('ignores an empty file selection and clears the input after an upload', () => {
  const calls = actions()
  render(<SessionTools {...calls} state={state({ snapshot: snapshot() })} disabled={false} t={t} />)
  const input = screen.getByLabelText<HTMLInputElement>(en.attachFile)
  fireEvent.change(input, { target: { files: [] } })
  expect(calls.upload).not.toHaveBeenCalled()
  expect(screen.queryByText(en.toolDetails)).toBeNull()
  const file = new File(['text'], 'input.txt', { type: 'text/plain' })
  fireEvent.change(input, { target: { files: [file] } })
  expect(calls.upload).toHaveBeenCalledExactlyOnceWith(file)
})

it('labels each terminal state and creates a terminal only from valid dimensions', () => {
  const terminals = (['running', 'exited', 'failed'] as const).map((value, index): Snapshot['terminals'][number] => ({
    id: brandString<Snapshot['terminals'][number]['id']>(`terminal-${index}`), title: `Shell ${index}`, cwd: '/project', cols: 80, rows: 24, shell, state: value, exitCode: null,
  }))
  const calls = actions()
  render(<SessionTools {...calls} state={state({ snapshot: snapshot({ terminals }) })} disabled={false} t={t} />)
  expect(screen.getByText(`Shell 0 · ${en.sessionRunning}`)).toBeTruthy()
  expect(screen.getByText(`Shell 1 · ${en.terminalExited}`)).toBeTruthy()
  expect(screen.getByText(`Shell 2 · ${en.terminalFailed}`)).toBeTruthy()
  const create = screen.getByRole('button', { name: en.newTerminal })
  const cols = screen.getByLabelText(en.terminalColumns)
  const rows = screen.getByLabelText(en.terminalRowsLabel)
  expect(cols).toHaveProperty('value', '100')
  expect(rows).toHaveProperty('value', '30')
  for (const [columns, lines] of [['1', '30'], ['80.5', '30'], ['80', '0'], ['80', '24.5']]) {
    fireEvent.change(cols, { target: { value: columns } }); fireEvent.change(rows, { target: { value: lines } })
    expect(create).toHaveProperty('disabled', true)
  }
  fireEvent.change(cols, { target: { value: '2' } }); fireEvent.change(rows, { target: { value: '1' } })
  fireEvent.click(create)
  expect(calls.terminalCreate).toHaveBeenCalledExactlyOnceWith(2, 1)
  expect(screen.queryByRole('button', { name: en.resizeTerminal })).toBeNull()
})

it('resizes the attached terminal and keeps input only for the controlling attachment', () => {
  const terminal: Terminal = { ...address, terminalId, attachmentId }
  const info: Snapshot['terminals'][number] = { id: terminalId, title: 'Shell', cwd: '/project', cols: 80, rows: 24, shell, state: 'running', exitCode: null, controllerId: attachmentId }
  const calls = actions()
  const view = render(tools(calls, state({ address, snapshot: snapshot({ terminals: [info] }), terminal, terminalInfo: info })))
  fireEvent.change(screen.getByLabelText(en.terminalColumns), { target: { value: '90' } })
  fireEvent.change(screen.getByLabelText(en.terminalRowsLabel), { target: { value: '20' } })
  fireEvent.click(screen.getByRole('button', { name: en.resizeTerminal }))
  expect(calls.interaction).toHaveBeenCalledExactlyOnceWith({ action: 'terminal-resize', ...terminal, cols: 90, rows: 20 })
  expect(screen.queryByText(en.terminalReadOnly)).toBeNull()
  expect(terminalProps.latest).toMatchObject({ identity: `remote:${attachmentId}`, disabled: false, label: en.terminalInput, failureLabel: en.terminalFailed })

  const readOnly = { ...info, controllerId: otherAttachmentId }
  const spectator = state({ address, snapshot: snapshot({ terminals: [readOnly] }), terminal, terminalInfo: readOnly,
    terminalOffline: true })
  view.rerender(tools(calls, spectator))
  expect(screen.getByText(en.terminalReadOnly)).toBeTruthy()
  expect(screen.getByText(en.terminalOffline)).toBeTruthy()
  expect(terminalProps.latest?.disabled).toBe(true)

  view.rerender(tools(calls, state({ address, snapshot: snapshot({ terminals: [info] }), terminal, terminalInfo: info }), true))
  expect(terminalProps.latest?.disabled).toBe(true)
  expect(screen.getByRole('button', { name: en.resizeTerminal })).toHaveProperty('disabled', true)

  view.rerender(tools(calls, state({ address, snapshot: snapshot({ terminals: [info] }), terminal })))
  expect(screen.queryByText(en.terminalReadOnly)).toBeNull()
  expect(terminalProps.latest?.disabled).toBe(true)
})

it('locks every control while the destination operation is busy', () => {
  const info: Snapshot['terminals'][number] = { id: terminalId, title: 'Shell', cwd: '/project', cols: 80, rows: 24, shell, state: 'running', exitCode: null }
  render(<SessionTools {...actions()} state={state({ busy: true, snapshot: snapshot({ terminals: [info] }) })} disabled={false} t={t} />)
  expect(screen.getByRole('button', { name: en.openTerminal })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.newTerminal })).toHaveProperty('disabled', true)
})
