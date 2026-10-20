// @vitest-environment jsdom
/** Destination pending questions, attachments and terminal controls. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteQuestions } from '../src/client/RemoteQuestions.tsx'
import { SessionTools, type SessionToolsActions } from '../src/client/SessionTools.tsx'
import type { EnvironmentPendingInteraction } from '../src/interaction-types.ts'
import type { InteractionState } from '../src/client/interaction-controller.ts'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)
const dictionary = { ...common, ...en }
const t = (key: keyof typeof dictionary) => dictionary[key]
const id = brandString<EnvironmentPendingInteraction['id']>('request')

it('shows approval context and submits one explicit decision', async () => {
  const approve = vi.fn()
  const view = render(<RemoteQuestions pending={{ kind: 'approval', id, toolName: 'bash', reason: 'Write the release file' }} disabled={false} t={t} approve={approve} answer={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: en.allowOnce }))
  fireEvent.click(screen.getByRole('button', { name: en.rejectRequest }))
  expect(approve.mock.calls).toEqual([['allowed-once'], ['rejected']])
  await expect(view.container.textContent).toMatchFileSnapshot('./expected/remote-approval.txt')
})

it('preserves option labels, validates every answer and supports free text with multi-selection', async () => {
  const answer = vi.fn()
  const pending: EnvironmentPendingInteraction = { kind: 'questions', id, questions: [
    { id: 'plan', header: 'Plan', question: 'Continue?', detail: '**Review this plan**', options: [{ label: 'Proceed', description: 'Run the plan' }, { label: 'Revise' }] },
    { id: 'targets', question: 'Targets?', multiSelect: true, options: [{ label: 'Linux' }, { label: 'Windows' }] },
  ] }
  const view = render(<RemoteQuestions pending={pending} disabled={false} t={t} approve={vi.fn()} answer={answer} />)
  expect(screen.getByRole('button', { name: en.submitAnswer }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByLabelText('ProceedRun the plan'))
  fireEvent.click(screen.getByLabelText('Linux'))
  fireEvent.click(screen.getByLabelText('Windows'))
  fireEvent.click(screen.getByLabelText('Linux'))
  fireEvent.change(screen.getAllByLabelText(en.customAnswer)[1]!, { target: { value: 'Also the test station' } })
  fireEvent.click(screen.getByRole('button', { name: en.submitAnswer }))
  expect(answer).toHaveBeenCalledWith({ answers: [
    { id: 'plan', selected: ['Proceed'], custom: '' }, { id: 'targets', selected: ['Windows'], custom: 'Also the test station' },
  ] })
  fireEvent.change(screen.getAllByLabelText(en.customAnswer)[0]!, { target: { value: 'Wait for review' } })
  expect(screen.getByLabelText('ProceedRun the plan')).toHaveProperty('checked', false)
  await expect(view.container.textContent).toMatchFileSnapshot('./expected/remote-questions.txt')
})

it('uses destination dimensions and IDs for attachment and terminal controls', async () => {
  const address = { environmentId: brandString<NonNullable<InteractionState['address']>['environmentId']>('remote'), workspaceId: brandString<NonNullable<InteractionState['address']>['workspaceId']>('workspace'), sessionId: brandString<NonNullable<InteractionState['address']>['sessionId']>('session') }
  const attachment = { attachmentId: brandString<NonNullable<InteractionState['snapshot']>['attachments'][number]['attachmentId']>('attachment'), name: 'result.txt', bytes: 42, mediaType: 'text/plain' }
  const terminalId = brandString<NonNullable<InteractionState['snapshot']>['terminals'][number]['id']>('terminal')
  const state: InteractionState = { address, loading: false, busy: false, offline: true, terminalOffline: false, terminalRevision: 0,
    terminalWritable: false,
    snapshot: {
      ...address, kind: 'snapshot', pending: [], attachments: [attachment], details: [{
        seq: 2, kind: 'tool-result', title: 'bash', text: 'done', isError: true }],
      terminals: [{
        id: terminalId, title: 'Shell', cwd: '/project', cols: 100, rows: 30, shell: { path: '/bin/sh', args: [], name: 'sh' }, state: 'running', exitCode: null }],
      capabilities: { attachments: true, approvals: true, terminals: true },
      maxUploadBytes: 1000, terminalCols: 100, terminalRows: 30, truncated: true,
    } }
  const actions: SessionToolsActions = { interaction: vi.fn(), upload: vi.fn(), download: vi.fn(), terminalConnect: vi.fn(),
    terminalCreate: vi.fn(), terminalWrite: vi.fn(), terminalRendered: vi.fn() }
  const view = render(<SessionTools {...actions} state={state} disabled={false} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.downloadFile })); expect(actions.download).toHaveBeenCalledWith(attachment)
  fireEvent.click(screen.getByRole('button', { name: en.openTerminal })); expect(actions.terminalConnect).toHaveBeenCalledWith(terminalId)
  fireEvent.click(screen.getByRole('button', { name: en.newTerminal })); expect(actions.terminalCreate).toHaveBeenCalledWith(100, 30)
  fireEvent.click(screen.getByRole('button', { name: en.closeTerminal })); expect(actions.interaction).toHaveBeenCalledWith({ action: 'terminal-close', terminalId })
  const file = new File(['text'], 'input.txt', { type: 'text/plain' })
  fireEvent.change(screen.getByLabelText(en.attachFile), { target: { files: [file] } }); expect(actions.upload).toHaveBeenCalledWith(file)
  await expect(view.container.textContent).toMatchFileSnapshot('./expected/remote-session-controls.txt')
})
