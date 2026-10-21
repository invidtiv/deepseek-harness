// @vitest-environment jsdom
/** Pairing operator controls: grants, invitation inventory, transfer code lifetime and failure feedback. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Pairing } from '../src/client/Pairing.tsx'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { EnvironmentConfiguration } from '../src/settings-types.ts'
import type { PairingAttemptMetadata, PairingGrants, PairingInvitation, PairingInvitationId, PairingInvitationMetadata } from '../src/pairing-types.ts'

const dictionary = { ...common, ...en }
const peerId = '22222222-2222-4222-8222-222222222222'
const strangerId = '33333333-3333-4333-8333-333333333333'
const invitationId = brandString<PairingInvitationId>('invitation')
const noGrants: PairingGrants = {
  workspaces: [], workspaceManagement: false, sessionAccess: false, attachmentAccess: false,
  approvalAccess: false, terminalAccess: false, teamAccess: false, teamOperate: false,
}

function configuration(overrides: Partial<EnvironmentConfiguration['config']> = {}): EnvironmentConfiguration {
  return {
    environmentId: brandString<EnvironmentConfiguration['environmentId']>('11111111-1111-4111-8111-111111111111'),
    revision: brandString<EnvironmentConfiguration['revision']>('revision'),
    config: { stateDirectory: '/private', label: 'machine', provider: 'provider', model: 'model', agentPreset: 'standard', sandboxMode: 'read-only', approvalPolicy: 'ask',
      workspaces: { project: '/checkout', docs: '/docs' }, peers: [{ environmentId: peerId, url: 'https://worker.example.ts.net', tokenEnv: 'DSH_PAIR', workspaces: ['project'] }],
      publicUrl: 'https://machine.example.ts.net', invitationLifetimeMs: 600000, maxInvitations: 32, terminalCols: 80, terminalRows: 24, maxUploadBytes: 1048576,
      requestTimeoutMs: 15000, retryIntervalMs: 5000, maxBytes: 1048576, maxTeams: 64, maxMembers: 16,
      maxTasks: 256, maxOperations: 2048, workspacePageSize: 100, sessionPageSize: 100,
      sessionSyncIntervalMs: 2000, sessionStreamHeartbeatMs: 2000, sessionStreamIdleTimeoutMs: 10000, ...overrides },
  }
}

function item(status: PairingInvitationMetadata['status'], target?: string, id = invitationId): PairingInvitationMetadata {
  return {
    id, grants: noGrants, createdAt: 0, expiresAt: 1, status,
    ...target ? { target: { environmentId: brandString<NonNullable<PairingInvitationMetadata['target']>['environmentId']>(target), url: `https://${target}.example.ts.net` } } : {},
  }
}

function attempt(status: PairingAttemptMetadata['status'], issuer: string, id: string): PairingAttemptMetadata {
  return {
    id: brandString<PairingInvitationId>(id), expiresAt: 1, status,
    issuer: { environmentId: brandString<PairingAttemptMetadata['issuer']['environmentId']>(issuer), url: `https://${issuer}.example.ts.net` },
  }
}

interface MountOptions { config?: EnvironmentConfiguration; list?: PairingInvitationMetadata[]; attempts?: PairingAttemptMetadata[] }
function mount(options: MountOptions = {}) {
  const pairingCreate = vi.fn<(grants: PairingGrants) => Promise<PairingInvitation>>()
  const pairingList = vi.fn<() => Promise<PairingInvitationMetadata[]>>().mockResolvedValue(options.list ?? [])
  const pairingRevoke = vi.fn<(id: PairingInvitationId) => Promise<void>>().mockResolvedValue(undefined)
  const pairingAccept = vi.fn().mockResolvedValue({})
  const pairingAttempts = vi.fn<() => Promise<PairingAttemptMetadata[]>>().mockResolvedValue(options.attempts ?? [])
  const pairingForget = vi.fn<(id: PairingInvitationId) => Promise<void>>().mockResolvedValue(undefined)
  const notify = vi.fn()
  const changed = vi.fn()
  const props = { t: (key: keyof typeof dictionary) => dictionary[key], configuration: options.config ?? configuration(), changed,
    pairingCreate, pairingList, pairingRevoke, pairingAccept, pairingAttempts, pairingForget, notify }
  const view = render(<Pairing {...props} />)
  return { props, ...props, ...view }
}

function invitation(expiresAt: number): PairingInvitation {
  return {
    id: invitationId, expiresAt, token: 'private-token',
    issuer: { environmentId: brandString<PairingInvitation['issuer']['environmentId']>('11111111-1111-4111-8111-111111111111'), url: 'https://machine.example.ts.net' },
  }
}

async function refresh() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.pairingRefresh })) })
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'clipboard')
})

it('toggles checkout and permission grants, keeping team operation implied by team access', async () => {
  const page = mount()
  page.pairingCreate.mockResolvedValue(invitation(Date.now() + 600000))
  await screen.findByText(en.pairingEmpty)
  fireEvent.click(screen.getByLabelText('project'))
  fireEvent.click(screen.getByLabelText('docs'))
  fireEvent.click(screen.getByLabelText('project'))
  fireEvent.click(screen.getByLabelText(en.pairingTeamOperate))
  expect(screen.getByLabelText(en.pairingTeamAccess)).toHaveProperty('checked', true)
  fireEvent.click(screen.getByLabelText(en.pairingTeamAccess))
  expect(screen.getByLabelText(en.pairingTeamOperate)).toHaveProperty('checked', false)
  fireEvent.click(screen.getByLabelText(en.pairingTeamAccess))
  fireEvent.click(screen.getByLabelText(en.pairingSessionAccess))
  fireEvent.click(screen.getByRole('button', { name: en.pairingCreate }))
  await screen.findByLabelText(en.pairingOutput)
  expect(page.pairingCreate).toHaveBeenCalledExactlyOnceWith({ ...noGrants, workspaces: ['docs'], teamAccess: true, sessionAccess: true })
})

it('lists every invitation state, revokes open invitations and refreshes the inventory', async () => {
  const page = mount({ list: [
    item('pending'), item('redeeming', strangerId, brandString<PairingInvitationId>('redeeming')),
    item('revoked', peerId, brandString<PairingInvitationId>('revoked')), item('expired', undefined, brandString<PairingInvitationId>('expired')),
  ] })
  await screen.findAllByText(en.pairingUnclaimed)
  expect(screen.getAllByText(en.pairingUnclaimed)).toHaveLength(2)
  expect(screen.getByText(en.pairingRevoked)).toBeTruthy()
  expect(screen.getByText(en.pairingExpired)).toBeTruthy()
  expect(screen.getByText(`https://${strangerId}.example.ts.net`)).toBeTruthy()
  const revoke = screen.getAllByRole('button', { name: en.pairingRevoke })
  expect(revoke).toHaveLength(2)
  fireEvent.click(revoke[0]!)
  await waitFor(() => { expect(page.pairingRevoke).toHaveBeenCalledExactlyOnceWith(invitationId) })
  await waitFor(() => { expect(page.notify).toHaveBeenCalledWith('pairingChanged') })
  await waitFor(() => { expect(page.pairingList).toHaveBeenCalledTimes(2) })
  page.pairingRevoke.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getAllByRole('button', { name: en.pairingRevoke })[1]!)
  await waitFor(() => { expect(page.notify).toHaveBeenCalledWith('pairingFailed') })
  await waitFor(() => { expect(screen.getAllByRole('button', { name: en.pairingRevoke })[0]).toHaveProperty('disabled', false) })
})

it('discards unfinished attempts only for installations that are not already connected', async () => {
  const page = mount({ attempts: [attempt('complete', peerId, 'connected'), attempt('pending', strangerId, 'unfinished')] })
  expect(await screen.findByText(en.pairingConsumed)).toBeTruthy()
  expect(screen.getByText(en.pairingRedeeming)).toBeTruthy()
  expect(screen.queryByText(en.pairingEmpty)).toBeNull()
  const forget = screen.getAllByRole('button', { name: en.pairingForget })
  expect(forget).toHaveLength(1)
  fireEvent.click(forget[0]!)
  await waitFor(() => { expect(page.pairingForget).toHaveBeenCalledExactlyOnceWith('unfinished') })
})

it('reports a failed inventory read, then recovers on refresh', async () => {
  const page = mount()
  await screen.findByText(en.pairingEmpty)
  page.pairingList.mockRejectedValueOnce(new Error('offline'))
  await refresh()
  expect((await screen.findByRole('alert')).textContent).toBe(en.pairingLoadingFailed)
  await refresh()
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
})

it('shows the loading indicator until the first inventory read settles', async () => {
  const page = mount()
  await screen.findByText(en.pairingEmpty)
  cleanup()
  const pending = new Promise<PairingInvitationMetadata[]>(() => {})
  page.pairingList.mockReturnValue(pending)
  render(<Pairing {...page.props} />)
  expect(screen.queryByText(en.pairingEmpty)).toBeNull()
  expect(document.querySelector('svg')).toBeTruthy()
})

it('ignores inventory results that settle after the panel closes', async () => {
  let resolve!: (value: PairingInvitationMetadata[]) => void
  let reject!: (error: Error) => void
  const first = new Promise<PairingInvitationMetadata[]>((yes) => { resolve = yes })
  const second = new Promise<PairingInvitationMetadata[]>((_yes, no) => { reject = no })
  const page = mount()
  await screen.findByText(en.pairingEmpty)
  page.unmount()
  for (const [pending, settle] of [[first, () => { resolve([item('consumed', strangerId)]) }], [second, () => { reject(new Error('offline')) }]] as const) {
    page.pairingList.mockReturnValue(pending)
    const view = render(<Pairing {...page.props} />)
    view.unmount()
    settle()
    await act(async () => { await pending.catch(() => {}) })
  }
  expect(page.changed).not.toHaveBeenCalled()
})

it('requests a configuration reload once per newly connected installation', async () => {
  const page = mount({ list: [
    item('consumed', strangerId), item('consumed', peerId, brandString<PairingInvitationId>('known')),
    item('consumed', undefined, brandString<PairingInvitationId>('untargeted')), item('pending', strangerId, brandString<PairingInvitationId>('open')),
  ] })
  await waitFor(() => { expect(page.changed).toHaveBeenCalledOnce() })
  await refresh()
  await waitFor(() => { expect(page.pairingList).toHaveBeenCalledTimes(2) })
  expect(page.changed).toHaveBeenCalledOnce()
})

it('explains a missing public URL, lists no checkouts and locks the transfer fields', async () => {
  mount({ config: configuration({ publicUrl: '', workspaces: {} }) })
  expect(screen.getByRole('status').textContent).toBe(en.pairingNeedsUrl)
  expect(screen.getByText(en.pairingNoWorkspaces)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.pairingCreate }).closest('fieldset')?.disabled).toBe(true)
  await screen.findByText(en.pairingEmpty)
})

it('keeps the generated code until it is hidden, copies it and reports clipboard refusal', async () => {
  const page = mount()
  page.pairingCreate.mockResolvedValue(invitation(Date.now() + 600000))
  fireEvent.click(screen.getByRole('button', { name: en.pairingCreate }))
  const output = await screen.findByLabelText<HTMLTextAreaElement>(en.pairingOutput)
  expect(screen.queryByText(en.pairingExpired, { selector: 'p' })).toBeNull()
  const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  fireEvent.click(screen.getByRole('button', { name: en.pairingCopy }))
  await waitFor(() => { expect(page.notify).toHaveBeenCalledWith('pairingFailed') })
  expect(screen.queryByRole('button', { name: en.copiedRemote })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.pairingCopy }))
  await screen.findByRole('button', { name: en.copiedRemote })
  expect(writeText).toHaveBeenLastCalledWith(output.value)
  fireEvent.click(screen.getByRole('button', { name: en.pairingHide }))
  expect(screen.queryByLabelText(en.pairingOutput)).toBeNull()
})

it('keeps the grants and shows no code when invitation creation fails', async () => {
  const page = mount()
  page.pairingCreate.mockRejectedValue(new Error('limit'))
  fireEvent.click(screen.getByRole('button', { name: en.pairingCreate }))
  await waitFor(() => { expect(page.notify).toHaveBeenCalledWith('pairingFailed') })
  expect(screen.queryByLabelText(en.pairingOutput)).toBeNull()
})

it('polls while a code is visible and stops after it expires', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const page = mount()
  page.pairingCreate.mockResolvedValue(invitation(Date.now() + 5000))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.pairingCreate })) })
  await screen.findByLabelText(en.pairingOutput)
  const reads = page.pairingList.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(page.pairingList.mock.calls.length).toBe(reads + 1)
  expect(screen.getByRole('button', { name: en.pairingCopy })).toHaveProperty('disabled', false)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.getByText(en.pairingExpired, { selector: 'p' })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.pairingCopy })).toHaveProperty('disabled', true)
  const settled = page.pairingList.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(page.pairingList.mock.calls.length).toBe(settled)
})

it.each([
  ['redeeming', true],
  ['consumed', false],
] as const)('keeps the code while its own invitation is %s only when the target is still redeeming', async (status, kept) => {
  const page = mount()
  page.pairingCreate.mockResolvedValue(invitation(Date.now() + 600000))
  fireEvent.click(screen.getByRole('button', { name: en.pairingCreate }))
  await screen.findByLabelText(en.pairingOutput)
  page.pairingList.mockResolvedValue([item('pending', undefined, brandString<PairingInvitationId>('other')), item(status, strangerId)])
  await refresh()
  await waitFor(() => { expect(screen.queryByLabelText(en.pairingOutput) !== null).toBe(kept) })
})

it('accepts a trimmed code from the target, clears the field and reloads configuration', async () => {
  const page = mount()
  fireEvent.click(screen.getByRole('button', { name: en.pairingEnterMode }))
  const accept = screen.getByRole('button', { name: en.pairingAccept })
  expect(accept).toHaveProperty('disabled', true)
  const input = screen.getByLabelText<HTMLTextAreaElement>(en.pairingInput)
  fireEvent.change(input, { target: { value: '   ' } })
  expect(accept).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByLabelText(en.pairingApprovalAccess))
  fireEvent.change(input, { target: { value: ' dsh-pair:code \n' } })
  fireEvent.click(accept)
  await waitFor(() => { expect(page.changed).toHaveBeenCalledOnce() })
  expect(page.pairingAccept).toHaveBeenCalledExactlyOnceWith('dsh-pair:code', { ...noGrants, approvalAccess: true })
  expect(input.value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: en.pairingGenerateMode }))
  expect(screen.getByRole('button', { name: en.pairingCreate })).toBeTruthy()
})
