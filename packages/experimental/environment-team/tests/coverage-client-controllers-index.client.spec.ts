// @vitest-environment jsdom
/** Client plugin wiring: Remote results become controller input, shell feedback and browser file effects. */
import { afterEach, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PageActions } from '../src/client/Page.tsx'
import type { NoticeFace } from '../src/client/Notice.tsx'
import type { EnvironmentsActions } from '../src/client/Environments.tsx'
import type { SessionsFace } from '../src/client/Sessions.tsx'
import type { TeamsFace } from '../src/client/Teams.tsx'
import type { EnvironmentWorkspace } from '../src/workspace-types.ts'
import type { SessionRequest } from '../src/session-types.ts'
import type { EnvironmentInteractionRequest, EnvironmentTerminalFollowRequest } from '../src/interaction-types.ts'
import type { PairingGrants, PairingInvitationId } from '../src/pairing-types.ts'
import type { TeamDashboardRequest } from '../src/team-types.ts'
import { apply } from '../src/client/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-environment-team/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-environment-team', descriptors: [] } }))

type EnvironmentId = EnvironmentWorkspace['environmentId']
const local = brandString<EnvironmentId>('11111111-1111-4111-8111-111111111111')
const peer = brandString<EnvironmentId>('22222222-2222-4222-8222-222222222222')
const target: EnvironmentWorkspace = { environmentId: local, workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('workspace'), alias: 'project', relativePath: '', path: '/srv/project', title: 'Project' }
const sibling: EnvironmentWorkspace = { ...target, workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('sibling') }
const remoteTarget: EnvironmentWorkspace = { ...target, environmentId: peer }
const terminalId = brandString<EnvironmentTerminalFollowRequest['terminalId']>('terminal')
const terminalInfo = { id: terminalId, title: 'shell', shell: { path: '/bin/sh', args: [], name: 'sh' }, cwd: '/srv/project', cols: 80, rows: 24, state: 'running', exitCode: null }
const grants: PairingGrants = {
  workspaces: [], workspaceManagement: false, sessionAccess: true, attachmentAccess: false,
  approvalAccess: false, terminalAccess: false, teamAccess: false, teamOperate: false,
}
const invitationId = brandString<PairingInvitationId>('invitation')
const configuration = { environmentId: local, config: { sessionSyncIntervalMs: 600000, peers: [] } }
const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'unavailable', {}) }
const ok = <T>(value: T) => ({ ok: true as const, value })
const maxUploadBytes = 1000

const mounts: Array<{ ctx: Context; dispose: () => Promise<void> }> = []
const urlDescriptors = { create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL') }
function restoreUrl(name: 'createObjectURL' | 'revokeObjectURL', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(URL, name)
  else Object.defineProperty(URL, name, descriptor)
}
afterEach(async () => {
  for (const { ctx, dispose } of mounts.splice(0)) { await dispose(); await ctx.fiber.dispose() }
  vi.restoreAllMocks()
  restoreUrl('createObjectURL', urlDescriptors.create); restoreUrl('revokeObjectURL', urlDescriptors.revoke)
})
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}
function assertPage(value: Record<string, unknown>): asserts value is Record<string, unknown> & PageActions {
  assert(typeof value.read === 'function' && typeof value.pairingForget === 'function')
}
function assertNotice(value: Record<string, unknown>): asserts value is Record<string, unknown> & NoticeFace {
  assert(typeof value.dismiss === 'function')
}
function assertBrowser(value: Record<string, unknown>): asserts value is Record<string, unknown> & EnvironmentsActions {
  assert(typeof value.environments === 'function' && typeof value.workspace === 'function')
}
function assertSessions(value: Record<string, unknown>): asserts value is Record<string, unknown> & SessionsFace {
  assert(typeof value.create === 'function' && typeof value.resume === 'function' && 'hooks' in value)
}
function assertTeams(value: Record<string, unknown>): asserts value is Record<string, unknown> & TeamsFace {
  assert(typeof value.selectTeam === 'function' && 'hooks' in value)
}

async function mount() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(_contribution: TypertRemoteContribution) { return unmount }
  }
  new Remote()
  const baseOf = (request: { workspaceId: EnvironmentWorkspace['workspaceId'] }, environmentId: EnvironmentId) => ({ environmentId, workspaceId: request.workspaceId })
  const settings = {
    read: vi.fn(async () => ok(configuration)),
    saveWithCredentials: vi.fn(async () => ok(configuration)),
    environments: vi.fn(async () => ok([{ environmentId: local, label: 'Local', local: true, status: 'online' }])),
    workspace: vi.fn(async () => ok({ kind: 'catalog', roots: [], workspaces: [], truncated: false })),
    session: vi.fn(async (environmentId: EnvironmentId, request: SessionRequest) => ok({
      ...baseOf(request, environmentId),
      ...(request.action === 'list' ? { kind: 'sessions', sessions: [], truncated: false }
        : request.action === 'read' ? { kind: 'snapshot', sessionId: request.sessionId, cursor: 0, running: false, messages: [], truncated: false }
          : { kind: request.action === 'create' ? 'created' : request.action === 'prompt' ? 'accepted' : 'cancelled', sessionId: request.sessionId }),
    })),
    sessionFollow: vi.fn(async function* (environmentId: EnvironmentId, request: { sessionId: string; workspaceId: EnvironmentWorkspace['workspaceId'] }, signal: AbortSignal) {
      yield { ...baseOf(request, environmentId), kind: 'snapshot', sessionId: request.sessionId, cursor: 0, running: false, messages: [], truncated: false }
      await untilAborted(signal)
    }),
    sessionInteraction: vi.fn(async (environmentId: EnvironmentId, request: EnvironmentInteractionRequest) => {
      const owner = { ...baseOf(request, environmentId), sessionId: request.sessionId }
      switch (request.action) {
        case 'snapshot': return ok({ ...owner, kind: 'snapshot', pending: [], attachments: [], details: [], terminals: [], capabilities: { attachments: true, approvals: true, terminals: true }, maxUploadBytes, terminalCols: 80, terminalRows: 24, truncated: false })
        case 'upload': return ok({ ...owner, kind: 'uploaded', upload: { receiptId: 'receipt', file: { name: request.name } } })
        case 'download': return ok({ ...owner, kind: 'download', data: btoa('hello'), attachment: { attachmentId: request.attachmentId, name: 'report.txt', bytes: 5, mediaType: 'text/plain' } })
        case 'terminal-create': return ok({ ...owner, kind: 'terminal', terminal: terminalInfo })
        case 'approval': case 'answer': case 'terminal-write': case 'terminal-resize': case 'terminal-close': return ok({ ...owner, kind: 'acknowledged' })
      }
    }),
    terminalFollow: vi.fn(async function* (
      _environment: EnvironmentId, _request: EnvironmentTerminalFollowRequest, signal: AbortSignal,
    ) { await untilAborted(signal) }),
    teamDashboard: vi.fn(async (environmentId: EnvironmentId, request: TeamDashboardRequest) => ok(request.action === 'catalog'
      ? { kind: 'catalog', environmentId, teams: [] }
      : request.action === 'read' ? { kind: 'team', environmentId, teamId: request.teamId, workspace: 'project', members: [], tasks: [], outbox: [] }
        : { kind: 'interrupted', environmentId, teamId: request.teamId, sessionId: request.sessionId, status: 'interrupt-requested' })),
    pairingCreate: vi.fn(async () => ok({ id: invitationId })),
    pairingList: vi.fn(async () => ok([])),
    pairingRevoke: vi.fn(async () => ok(undefined)),
    pairingImport: vi.fn(async () => ok({ id: invitationId })),
    pairingAttempts: vi.fn(async () => ok([])),
    pairingForget: vi.fn(async () => ok(undefined)),
  }
  const selectPanel = vi.fn()
  ctx.provide('remote.environmentTeamSettings', settings)
  ctx.provide('remote.credentials', { set: vi.fn() })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('layout', { selectPanel })
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
  } }, (_props: PropsRenderSlots<'plugins.bundle.config' | 'shell.overlay' | 'main' | 'sidebar.panellist'>) => null)
  const disposeOnce = await apply(ctx)
  let disposed: Promise<void> | undefined
  const dispose = () => disposed ??= disposeOnce()
  mounts.push({ ctx, dispose })
  const main = (key: string) => ctx.slots.entries('main').find(entry => entry.options.key === key)!.inject!()
  const page = ctx.slots.entries('plugins.bundle.config')[0]!.inject!()
  assertPage(page)
  const notice = ctx.slots.entries('shell.overlay')[0]!.inject!()
  assertNotice(notice)
  const browser = main('environments'); assertBrowser(browser)
  const panel = main('environment-sessions'); assertSessions(panel)
  const teams = main('environment-teams'); assertTeams(teams)
  const noticeKind = () => notice.hooks.environmentNotice.getSnapshot().kind
  return { ctx, settings, selectPanel, unmount, dispose, page, notice, noticeKind, browser, panel, teams }
}
type Mounted = Awaited<ReturnType<typeof mount>>

/** Mounted plugin with a created destination Session whose interaction snapshot has been read. */
async function ready(): Promise<Mounted> {
  const m = await mount()
  m.browser.openSessions!(target); m.panel.resume(); m.panel.create()
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().snapshot).toBeDefined() })
  return m
}
/** Let every already-queued promise continuation run; the awaited chains use no timers. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
function sessionOf(m: Mounted) { return m.panel.hooks.remoteSessions.getSnapshot().sessionId! }
/** File whose bytes are read through a spy so tests can observe or hold the read. */
function fileOf(name: string, type: string, size = 5, read: () => Promise<ArrayBuffer> = async () => new ArrayBuffer(size)) {
  const file = new File([new Uint8Array(size)], name, { type })
  const arrayBuffer = vi.fn(read)
  Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
  return { file, arrayBuffer }
}
function uploads(m: Mounted) { return m.settings.sessionInteraction.mock.calls.filter(([, request]) => request.action === 'upload') }

it('labels each sidebar panel', async () => {
  const m = await mount()
  const labels = m.ctx.slots.entries('sidebar.panellist').map(entry => resolveSlotLabel(entry.options.label))
  expect(labels).toEqual(expect.arrayContaining(['Environments', 'Distributed teams', 'Remote sessions']))
})

it.each([
  ['pairingCreate', 'pairingCreate', (m: Mounted) => m.page.pairingCreate(grants)],
  ['pairingList', 'pairingList', (m: Mounted) => m.page.pairingList()],
  ['pairingRevoke', 'pairingRevoke', (m: Mounted) => m.page.pairingRevoke(invitationId)],
  ['pairingAccept', 'pairingImport', (m: Mounted) => m.page.pairingAccept('invitation-code', grants)],
  ['pairingAttempts', 'pairingAttempts', (m: Mounted) => m.page.pairingAttempts()],
  ['pairingForget', 'pairingForget', (m: Mounted) => m.page.pairingForget(invitationId)],
] as const)('forwards %s to %s and rethrows the destination error', async (_action, remote, run) => {
  const m = await mount()
  await run(m)
  expect(m.settings[remote]).toHaveBeenCalledOnce()
  m.settings[remote].mockResolvedValueOnce(failure as never)
  await expect(run(m)).rejects.toThrow('unavailable')
})

it('returns pairing values from the destination', async () => {
  const m = await mount()
  expect(await m.page.pairingCreate(grants)).toEqual({ id: invitationId })
  expect(await m.page.pairingList()).toEqual([])
  expect(await m.page.pairingAccept('code', grants)).toEqual({ id: invitationId })
  expect(await m.page.pairingAttempts()).toEqual([])
})

it('reads the team dashboard, interrupts a member and reports each outcome in the shell', async () => {
  const m = await mount()
  const team = brandString<Parameters<TeamsFace['selectTeam']>[0]>('team')
  const member = brandString<Parameters<TeamsFace['interrupt']>[0]>('member')
  m.teams.resume()
  await vi.waitFor(() => { expect(m.teams.hooks.remoteTeams.getSnapshot()).toMatchObject({ environmentId: local, catalog: { kind: 'catalog' } }) })
  m.teams.selectEnvironment(local); m.teams.selectTeam(team)
  await vi.waitFor(() => { expect(m.teams.hooks.remoteTeams.getSnapshot().detail).toMatchObject({ teamId: team }) })
  m.teams.interrupt(member)
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('teamInterrupted') })
  await vi.waitFor(() => { expect(m.teams.hooks.remoteTeams.getSnapshot().busy).toBe(false) })
  const dashboard = m.settings.teamDashboard.getMockImplementation()!
  m.settings.teamDashboard.mockImplementation(async (environmentId, request) => {
    if (request.action === 'interrupt') throw new Error('connection lost')
    return dashboard(environmentId, request)
  })
  m.notice.dismiss()
  m.teams.interrupt(member)
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('teamInterruptFailed') })
  await vi.waitFor(() => { expect(m.teams.hooks.remoteTeams.getSnapshot().busy).toBe(false) })
  m.teams.pause()
  m.teams.refresh()
  expect(m.teams.hooks.remoteTeams.getSnapshot().loading).toBe(false)
})

it.each([
  ['teamDashboard', (m: Mounted) => { m.settings.teamDashboard.mockResolvedValueOnce(failure as never) }],
  ['environments', (m: Mounted) => { m.settings.environments.mockResolvedValueOnce(failure as never) }],
  ['read', (m: Mounted) => { m.settings.read.mockResolvedValueOnce(failure as never) }],
] as const)('marks the team dashboard offline when %s fails', async (_name, fail) => {
  const m = await mount()
  fail(m)
  m.teams.resume()
  await vi.waitFor(() => { expect(m.teams.hooks.remoteTeams.getSnapshot()).toMatchObject({ offline: true, loading: false }) })
})

it('marks session interactions offline when the destination snapshot or refresh interval fails', async () => {
  const m = await mount()
  m.browser.openSessions!(target); m.panel.resume(); m.panel.create()
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().snapshot).toBeDefined() })
  m.settings.sessionInteraction.mockResolvedValueOnce(failure as never)
  m.settings.read.mockResolvedValueOnce(failure as never)
  m.panel.refresh()
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().offline).toBe(true) })
  m.ctx.emit('connection/reset')
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().offline).toBe(false) })
})

it('forwards session navigation, drafting and paging controls to the selected destination', async () => {
  const m = await ready()
  const id = sessionOf(m)
  m.panel.olderSessions(); m.panel.backToLatestSessions(); m.panel.earlier(); m.panel.backToLive()
  m.panel.draft('Hello'); m.panel.send()
  await vi.waitFor(() => { expect(m.settings.session.mock.calls.some(([, request]) => request.action === 'prompt')).toBe(true) })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteSessions.getSnapshot().busy).toBe(false) })
  m.panel.cancel()
  await vi.waitFor(() => { expect(m.settings.session.mock.calls.some(([, request]) => request.action === 'cancel')).toBe(true) })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteSessions.getSnapshot().busy).toBe(false) })
  m.panel.select(id); m.panel.removeAttachment(0)
  m.panel.pause(); m.panel.back()
  expect(m.selectPanel).toHaveBeenLastCalledWith('environments')
})

it('runs explicit interactions and reports their acknowledgement or failure in the shell', async () => {
  const m = await ready()
  m.notice.dismiss()
  m.panel.interaction({ action: 'terminal-close', terminalId })
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('sessionChanged') })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  m.settings.sessionInteraction.mockResolvedValueOnce(failure as never)
  m.panel.interaction({ action: 'terminal-close', terminalId })
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('sessionChangeFailed') })
})

it('attaches to a created terminal, forwards keyboard input and acknowledges rendered frames', async () => {
  const m = await ready()
  m.panel.terminalCreate(80, 24)
  await vi.waitFor(() => { expect(m.settings.terminalFollow).toHaveBeenCalledOnce() })
  expect(m.settings.terminalFollow.mock.calls[0]![1]).toMatchObject({ terminalId })
  m.panel.terminalWrite('ls\n')
  await vi.waitFor(() => { expect(m.settings.sessionInteraction.mock.calls.some(([, request]) => request.action === 'terminal-write' && request.data === 'ls\n')).toBe(true) })
  m.panel.terminalRendered(0)
  m.panel.terminalConnect(terminalId)
  await vi.waitFor(() => { expect(m.settings.terminalFollow).toHaveBeenCalledTimes(2) })
})

it('does not attach a terminal when its creation was not acknowledged as a terminal', async () => {
  const m = await ready()
  m.settings.sessionInteraction.mockResolvedValueOnce(failure as never)
  m.panel.terminalCreate(80, 24)
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('sessionChangeFailed') })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  m.settings.sessionInteraction.mockImplementationOnce(async (environmentId, request) => ok({ environmentId, workspaceId: request.workspaceId, sessionId: request.sessionId, kind: 'acknowledged' }))
  m.panel.terminalCreate(80, 24)
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  expect(m.settings.terminalFollow).not.toHaveBeenCalled()
})

it('stages a destination receipt for a non-image upload and ignores any other reply', async () => {
  const m = await ready()
  const { file } = fileOf('notes.txt', 'text/plain')
  m.panel.upload(file)
  await vi.waitFor(() => { expect(m.panel.hooks.remoteSessions.getSnapshot().attachments).toEqual([{ name: 'notes.txt', receipt: 'receipt' }]) })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  m.settings.sessionInteraction.mockImplementationOnce(async (environmentId, request) => ok({ environmentId, workspaceId: request.workspaceId, sessionId: request.sessionId, kind: 'acknowledged' }))
  m.panel.upload(fileOf('other.txt', 'text/plain').file)
  await vi.waitFor(() => { expect(uploads(m)).toHaveLength(2) })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  await settle()
  expect(m.panel.hooks.remoteSessions.getSnapshot().attachments).toHaveLength(1)
})

it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const)('stages %s inline without an upload request', async (type) => {
  const m = await ready()
  m.notice.dismiss()
  m.panel.upload(fileOf('picture', type).file)
  await vi.waitFor(() => { expect(m.panel.hooks.remoteSessions.getSnapshot().attachments).toEqual([{ name: 'picture', image: { data: btoa('\0\0\0\0\0'), mediaType: type, name: 'picture' } }]) })
  expect(m.noticeKind()).toBe('sessionChanged')
  expect(uploads(m)).toHaveLength(0)
})

it('rejects a file above the destination limit before reading it', async () => {
  const m = await ready()
  const { file, arrayBuffer } = fileOf('big.bin', 'application/octet-stream', maxUploadBytes + 1)
  m.panel.upload(file)
  expect(m.noticeKind()).toBe('attachmentTooLarge')
  expect(arrayBuffer).not.toHaveBeenCalled()
})

it('ignores an upload before any destination snapshot is available', async () => {
  const m = await mount()
  const { file, arrayBuffer } = fileOf('notes.txt', 'text/plain')
  m.panel.upload(file)
  expect(arrayBuffer).not.toHaveBeenCalled()
  expect(m.noticeKind()).toBeNull()
})

it('ignores an upload while a conversation mutation is pending or its outcome is uncertain', async () => {
  const m = await ready()
  const pending = Promise.withResolvers<ReturnType<typeof ok>>()
  m.settings.session.mockImplementationOnce(async () => pending.promise as never)
  m.panel.cancel()
  expect(m.panel.hooks.remoteSessions.getSnapshot().busy).toBe(true)
  const busy = fileOf('busy.txt', 'text/plain')
  m.panel.upload(busy.file)
  expect(busy.arrayBuffer).not.toHaveBeenCalled()
  pending.resolve(ok({ environmentId: local, workspaceId: target.workspaceId, kind: 'cancelled', sessionId: sessionOf(m) }))
  await vi.waitFor(() => { expect(m.panel.hooks.remoteSessions.getSnapshot().busy).toBe(false) })
  m.settings.session.mockRejectedValueOnce(new Error('response lost'))
  m.panel.draft('Hello'); m.panel.send()
  await vi.waitFor(() => { expect(m.panel.hooks.remoteSessions.getSnapshot().uncertain).toBe(true) })
  const uncertain = fileOf('uncertain.txt', 'text/plain')
  m.panel.upload(uncertain.file)
  expect(uncertain.arrayBuffer).not.toHaveBeenCalled()
})

it.each(['session', 'workspace', 'machine'] as const)('discards an upload whose %s changed while its bytes were being read', async (change) => {
  const m = await ready()
  const bytes = Promise.withResolvers<ArrayBuffer>()
  const held = fileOf('late.txt', 'text/plain', 5, () => bytes.promise)
  m.panel.upload(held.file)
  const id = sessionOf(m)
  if (change === 'session') m.panel.select(brandString<typeof id>('another-session'))
  else {
    m.browser.openSessions!(change === 'workspace' ? sibling : remoteTarget)
    m.panel.select(id)
  }
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().address?.sessionId).toBe(change === 'session' ? 'another-session' : id) })
  bytes.resolve(new ArrayBuffer(5))
  await settle()
  expect(uploads(m)).toHaveLength(0)
  expect(m.panel.hooks.remoteSessions.getSnapshot().attachments).toBeUndefined()
})

it('reports a file that cannot be read', async () => {
  const m = await ready()
  const unreadable = fileOf('broken.txt', 'text/plain', 5, async () => { throw new Error('read failed') })
  m.notice.dismiss()
  m.panel.upload(unreadable.file)
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('sessionChangeFailed') })
})

it('saves downloaded bytes, replaces the previous download URL and withdraws the last one on disposal', async () => {
  const m = await ready()
  const urls = ['blob:first', 'blob:second']
  const createObjectURL = vi.fn(() => urls.shift()!)
  const revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
  const saved: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(`${this.href}|${this.download}`) })
  const attachment = { attachmentId: brandString<Parameters<SessionsFace['download']>[0]['attachmentId']>('attachment'), name: 'report.txt', bytes: 5, mediaType: 'text/plain' }
  m.panel.download(attachment)
  await vi.waitFor(() => { expect(saved).toEqual(['blob:first|report.txt']) })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  expect(revokeObjectURL).not.toHaveBeenCalled()
  m.panel.download(attachment)
  await vi.waitFor(() => { expect(saved).toHaveLength(2) })
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:first')
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  await m.dispose()
  expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:second')
})

it('ignores a download reply of another kind and reports bytes that cannot be saved', async () => {
  const m = await ready()
  const attachment = { attachmentId: brandString<Parameters<SessionsFace['download']>[0]['attachmentId']>('attachment'), name: 'report.txt', bytes: 5, mediaType: 'text/plain' }
  m.settings.sessionInteraction.mockImplementationOnce(async (environmentId, request) => ok({ environmentId, workspaceId: request.workspaceId, sessionId: request.sessionId, kind: 'acknowledged' }))
  m.notice.dismiss()
  m.panel.download(attachment)
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('sessionChanged') })
  await vi.waitFor(() => { expect(m.panel.hooks.remoteInteractions.getSnapshot().busy).toBe(false) })
  m.settings.sessionInteraction.mockImplementationOnce(async (environmentId, request) => ok({ environmentId, workspaceId: request.workspaceId, sessionId: request.sessionId, kind: 'download', data: '***', attachment }))
  m.panel.download(attachment)
  await vi.waitFor(() => { expect(m.noticeKind()).toBe('sessionChangeFailed') })
})
