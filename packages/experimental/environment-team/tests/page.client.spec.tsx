// @vitest-environment jsdom
/** Operator edits stay staged, and blank secret fields retain saved credentials. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Page, type PageProps } from '../src/client/Page.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { Notice, type NoticeState } from '../src/client/Notice.tsx'
import type { EnvironmentConfiguration } from '../src/settings-types.ts'

afterEach(cleanup)
const dictionary = { ...commonEn, ...en }
const translate: PageProps['t'] = key => dictionary[key]
const initial: EnvironmentConfiguration = {
  environmentId: brandString<EnvironmentConfiguration['environmentId']>('11111111-1111-4111-8111-111111111111'), revision: brandString<EnvironmentConfiguration['revision']>('revision'),
  config: { stateDirectory: '/private', label: 'machine', provider: 'provider', model: 'model', agentPreset: 'standard', sandboxMode: 'read-only', approvalPolicy: 'ask',
    workspaces: { project: '/checkout' }, peers: [{ environmentId: '22222222-2222-4222-8222-222222222222', url: 'https://worker.example.ts.net', tokenEnv: 'DSH_PAIR', workspaces: ['project'] }],
    requestTimeoutMs: 15000, retryIntervalMs: 5000, maxBytes: 1048576, maxTeams: 64, maxMembers: 16, maxTasks: 256, maxOperations: 2048 },
}
function mount(options: { read?: () => Promise<EnvironmentConfiguration>; view?: PageProps['view'] } = {}) {
  const read = vi.fn(options.read ?? (async () => structuredClone(initial)))
  const save = vi.fn(async (value: EnvironmentConfiguration) => value)
  const credential = vi.fn().mockResolvedValue(undefined)
  const notify = vi.fn()
  const props = { view: options.view ?? 'page', t: translate, read, save, credential, notify } satisfies PageProps
  const rendered = render(<Page {...props} />)
  return { read, save, credential, notify, ...rendered }
}

it('saves machine and checkout edits without rewriting an existing pairing secret', async () => {
  const { save, credential, notify } = mount()
  fireEvent.change(await screen.findByLabelText('Machine label'), { target: { value: 'linux' } })
  fireEvent.change(screen.getByLabelText('Local directory'), { target: { value: '/srv/repository' } })
  fireEvent.change(screen.getByLabelText('Tailscale HTTPS URL'), { target: { value: 'https://new-host.example.ts.net' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
  expect(save.mock.calls[0]?.[0].config).toMatchObject({ label: 'linux', workspaces: { project: '/srv/repository' }, peers: [{ url: 'https://new-host.example.ts.net', tokenEnv: 'DSH_PAIR' }] })
  expect(credential).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith('saved')
})

it('stores a typed secret separately and preserves the draft when the profile refuses the save', async () => {
  const { save, credential, notify } = mount()
  save.mockRejectedValueOnce(new Error('stale revision'))
  fireEvent.change(await screen.findByLabelText('Pairing secret'), { target: { value: 'private-pair-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => { expect(notify).toHaveBeenCalledWith('saveFailed') })
  expect(credential).toHaveBeenCalledWith('DSH_PAIR', 'private-pair-secret')
  expect(JSON.stringify(save.mock.calls[0])).not.toContain('private-pair-secret')
  expect(screen.getByLabelText('Pairing secret')).toHaveProperty('value', 'private-pair-secret')
})

it('refuses duplicate checkout aliases without writing configuration', async () => {
  const { save } = mount()
  await screen.findByLabelText('Machine label')
  fireEvent.click(screen.getByRole('button', { name: 'Add checkout' }))
  fireEvent.change(screen.getAllByLabelText('Project alias')[1]!, { target: { value: 'project' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Checkout aliases must be unique')
  expect(save).not.toHaveBeenCalled()
})

it('edits worker policy, project grants, and limits while retaining other peer secret drafts', async () => {
  const { save, credential } = mount()
  await screen.findByLabelText('Machine label')
  fireEvent.change(screen.getByLabelText('Model provider'), { target: { value: 'local-provider' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'local-model' } })
  fireEvent.change(screen.getByLabelText('Agent preset'), { target: { value: 'worker' } })
  fireEvent.change(screen.getByLabelText('Sandbox mode'), { target: { value: 'workspace-write' } })
  fireEvent.change(screen.getByLabelText('Approval policy'), { target: { value: 'never' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add checkout' }))
  fireEvent.change(screen.getAllByLabelText('Project alias')[1]!, { target: { value: 'second' } })
  fireEvent.change(screen.getAllByLabelText('Local directory')[1]!, { target: { value: '/second' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
  fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
  fireEvent.change(screen.getAllByLabelText('Peer environment ID')[1]!, { target: { value: '33333333-3333-4333-8333-333333333333' } })
  fireEvent.change(screen.getAllByLabelText('Tailscale HTTPS URL')[1]!, { target: { value: 'https://second.example.ts.net' } })
  fireEvent.change(screen.getAllByLabelText('Allowed project aliases (comma separated)')[1]!, { target: { value: 'second, shared' } })
  fireEvent.change(screen.getAllByLabelText('Pairing secret')[0]!, { target: { value: 'first-secret' } })
  fireEvent.change(screen.getAllByLabelText('Pairing secret')[1]!, { target: { value: 'second-secret' } })
  fireEvent.change(screen.getAllByLabelText('Pairing secret')[2]!, { target: { value: 'discarded-secret' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[3]!)
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!)
  expect(screen.getByLabelText('Pairing secret')).toHaveProperty('value', 'second-secret')
  fireEvent.change(screen.getByLabelText('Request timeout (ms)'), { target: { value: '20000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
  expect(save.mock.calls[0]?.[0].config).toMatchObject({ provider: 'local-provider', model: 'local-model', agentPreset: 'worker', sandboxMode: 'workspace-write', approvalPolicy: 'never', workspaces: { second: '/second' }, requestTimeoutMs: 20000,
    peers: [{ environmentId: '33333333-3333-4333-8333-333333333333', workspaces: ['second', 'shared'] }] })
  expect(credential).toHaveBeenCalledExactlyOnceWith('DSH_PEER_33333333_3333_4333_8333_333333333333', 'second-secret')
})

it('rejects empty aliases and non-positive limits, and reload discards unsaved edits', async () => {
  const { read, save } = mount()
  fireEvent.change(await screen.findByLabelText('Project alias'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  expect((await screen.findByRole('alert')).textContent).toContain(en.invalidWorkspace)
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(screen.getByLabelText('Project alias')).toHaveProperty('value', 'project') })
  fireEvent.change(screen.getByLabelText('Members per team'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  expect((await screen.findByRole('alert')).textContent).toContain(en.invalidNumber)
  expect(save).not.toHaveBeenCalled()
  expect(read).toHaveBeenCalledTimes(2)
})

it('retries a failed initial read and keeps populated values when a later reload fails', async () => {
  const read = vi.fn<() => Promise<EnvironmentConfiguration>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('offline'))
  mount({ read })
  expect((await screen.findByRole('alert')).textContent).toContain(en.loadingFailed)
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  await screen.findByLabelText('Machine label')
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  expect((await screen.findByRole('alert')).textContent).toContain(en.loadingFailed)
  expect(screen.getByLabelText('Machine label')).toHaveProperty('value', 'machine')
})

it.each(['resolve', 'reject'] as const)('ignores a late %s after the page closes', async (outcome) => {
  let resolve!: (value: EnvironmentConfiguration) => void
  let reject!: (error: Error) => void
  const pending = new Promise<EnvironmentConfiguration>((yes, no) => { resolve = yes; reject = no })
  const page = mount({ read: () => pending })
  page.unmount()
  await act(async () => { if (outcome === 'resolve') resolve(initial); else reject(new Error('offline')); await pending.catch(() => {}) })
  expect(screen.queryByLabelText('Machine label')).toBeNull()
})

it('shows the bundle summary without loading operator configuration', () => {
  const { read } = mount({ view: 'summary' })
  expect(screen.getByText(en.description)).toBeTruthy()
  expect(read).not.toHaveBeenCalled()
})

it('renders global success and failure feedback and acknowledges the completed toast', async () => {
  vi.useFakeTimers()
  try {
    const dismiss = vi.fn()
    let state: NoticeState = { kind: null, sequence: 0 }
    const props = {
      t: translate,
      useEnvironmentNotice: <T,>(select: (value: NoticeState) => T) => select(state), dismiss,
    }
    const view = render(<Notice {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    state = { kind: 'saved', sequence: 1 }
    view.rerender(<Notice {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en.saved)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(dismiss).toHaveBeenCalledOnce()
    state = { kind: 'saveFailed', sequence: 2 }
    view.rerender(<Notice {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
    view.unmount()
  } finally { vi.useRealTimers() }
})
