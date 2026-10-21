/** Operator routing of dashboard, Session interaction and terminal operations to exactly one destination. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { descriptorSchema } from '../src/protocol.ts'
import { environmentTerminalFrameSchema, interactionRequestSchema, interactionResultSchema, terminalFollowRequestSchema } from '../src/interaction-protocol.ts'
import { EnvironmentSessionInteractions } from '../src/session-interactions.ts'
import { teamDashboardRequestSchema, teamDashboardResultSchema } from '../src/team-dashboard-protocol.ts'
import { EnvironmentTeamsProvider, type EnvironmentTeamDashboard } from '../src/team-dashboard.ts'
import type { EnvironmentConfiguration } from '../src/settings-types.ts'
import type { EnvironmentTarget } from '../src/workspace-types.ts'
import { PeerTransport } from '../src/transport.ts'
import { pairingHost } from './pairing-host.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const host = () => pairingHost((close) => { closes.push(close) })
const signal = new AbortController().signal
const remote = () => brandString<EnvironmentConfiguration['environmentId']>(randomUUID())
const descriptor = (environmentId: EnvironmentTarget['environmentId'], capabilities: Record<string, boolean>) =>
  descriptorSchema.parse({ environmentId, label: 'peer', platform: 'linux', protocol: 1, capabilities: { distributedTeams: true, ...capabilities } })

const publish = (ctx: Context, runtime: EnvironmentTeamDashboard) =>
  ctx.plugin({ name: `team-runtime-${randomUUID()}`, apply(scope: Context) { new EnvironmentTeamsProvider(scope, runtime) } })

it('serves a local dashboard only from the live team runtime of this installation', async () => {
  const { ctx, controller } = await host()
  const local = (await controller.read()).environmentId
  const request = teamDashboardRequestSchema.parse({ action: 'catalog' })
  const result = teamDashboardResultSchema.parse({ kind: 'catalog', environmentId: local, teams: [] })
  const dashboard = vi.fn(async () => result)
  const foreign = await publish(ctx, { environmentId: brandString<typeof local>(randomUUID()), dashboard })
  await expect(controller.teamDashboard(local, request, signal)).rejects.toThrow('team runtime is unavailable')
  await foreign.dispose()
  await publish(ctx, { environmentId: local, dashboard })
  expect(await controller.teamDashboard(local, request, signal)).toEqual(result)
  expect(dashboard).toHaveBeenCalledWith(local, request, expect.any(AbortSignal))
})

it('validates that a peer dashboard response matches the operation, team and member it was asked about', async () => {
  const { controller } = await host()
  const target = remote()
  vi.spyOn(PeerTransport.prototype, 'describe').mockResolvedValue(descriptor(target, { teamDashboard: true }))
  const call = vi.spyOn(PeerTransport.prototype, 'call')
  const read = teamDashboardRequestSchema.parse({ action: 'read', teamId: 'team-1' })
  const interrupt = teamDashboardRequestSchema.parse({ action: 'interrupt', teamId: 'team-1', sessionId: 'member-1' })
  const team = { kind: 'team', environmentId: target, teamId: 'team-1', workspace: 'project', members: [], tasks: [], outbox: [] }
  const interrupted = { kind: 'interrupted', environmentId: target, teamId: 'team-1', sessionId: 'member-1', status: 'inactive' }
  call.mockResolvedValueOnce(JSON.stringify(team))
  expect(await controller.teamDashboard(target, read, signal)).toEqual(team)
  call.mockResolvedValueOnce(JSON.stringify(interrupted))
  expect(await controller.teamDashboard(target, interrupt, signal)).toEqual(interrupted)
  call.mockResolvedValueOnce(JSON.stringify({ kind: 'catalog', environmentId: target, teams: [] }))
  await expect(controller.teamDashboard(target, read, signal)).rejects.toThrow('response mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ ...team, teamId: 'team-2' }))
  await expect(controller.teamDashboard(target, read, signal)).rejects.toThrow('identity mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ ...interrupted, teamId: 'team-2' }))
  await expect(controller.teamDashboard(target, interrupt, signal)).rejects.toThrow('identity mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ ...interrupted, sessionId: 'member-2' }))
  await expect(controller.teamDashboard(target, interrupt, signal)).rejects.toThrow('member mismatch')
})

const scope = { workspaceId: 'workspace', sessionId: 'session' }
const terminal = { id: 'term-1', title: 'shell', shell: { path: '/bin/sh', args: [], name: 'sh' }, cwd: '/', cols: 80, rows: 24, state: 'running', exitCode: null }
const requests = [
  ['snapshot', { action: 'snapshot' }],
  ['uploaded', { action: 'upload', data: 'AA==', name: 'a.txt' }],
  ['download', { action: 'download', attachmentId: 'file-1' }],
  ['terminal', { action: 'terminal-create', request: { id: 'term-1', cols: 80, rows: 24 } }],
  ['acknowledged', { action: 'terminal-close', terminalId: 'term-1' }],
] as const
const results = (environmentId: string): Record<(typeof requests)[number][0], object> => ({
  snapshot: { kind: 'snapshot', environmentId, ...scope, pending: [], attachments: [], details: [], terminals: [], capabilities: { attachments: true, approvals: true, terminals: true }, maxUploadBytes: 1, terminalCols: 80, terminalRows: 24, truncated: false },
  uploaded: { kind: 'uploaded', environmentId, ...scope, upload: { receiptId: 'receipt', file: { attachmentId: 'file-1', name: 'a.txt', bytes: 1 } } },
  download: { kind: 'download', environmentId, ...scope, attachment: { attachmentId: 'file-1', name: 'a.txt', bytes: 1, mediaType: 'text/plain' }, data: 'AA==' },
  terminal: { kind: 'terminal', environmentId, ...scope, terminal },
  acknowledged: { kind: 'acknowledged', environmentId, ...scope },
})

it('runs Session interactions locally when addressed to this installation without contacting a peer', async () => {
  const { controller } = await host()
  const local = (await controller.read()).environmentId
  const request = interactionRequestSchema.parse({ ...scope, action: 'snapshot' })
  const result = interactionResultSchema.parse(results(local).snapshot)
  const run = vi.spyOn(EnvironmentSessionInteractions.prototype, 'run').mockResolvedValue(result)
  const describe = vi.spyOn(PeerTransport.prototype, 'describe')
  expect(await controller.sessionInteraction(local, request, signal)).toEqual(result)
  expect(run).toHaveBeenCalledWith(local, request, expect.any(AbortSignal))
  expect(describe).not.toHaveBeenCalled()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(controller.sessionInteraction(local, request, cancelled.signal)).rejects.toThrow()
  expect(run).toHaveBeenCalledTimes(1)
})

it.each(requests)('accepts only the %s response from the addressed peer Session', async (kind, input) => {
  const { controller } = await host()
  const target = remote()
  const request = interactionRequestSchema.parse({ ...scope, ...input })
  const describe = vi.spyOn(PeerTransport.prototype, 'describe').mockResolvedValue(descriptor(target, { workspaceSessionInteractions: true }))
  const call = vi.spyOn(PeerTransport.prototype, 'call').mockResolvedValue(JSON.stringify(results(target)[kind]))
  expect(await controller.sessionInteraction(target, request, signal)).toMatchObject({ kind, environmentId: target })
  expect(call).toHaveBeenCalledWith(target, { kind: 'session-interaction', environmentId: target, request }, expect.any(AbortSignal))
  const wrong = kind === 'acknowledged' ? 'snapshot' : 'acknowledged'
  call.mockResolvedValueOnce(JSON.stringify(results(target)[wrong]))
  await expect(controller.sessionInteraction(target, request, signal)).rejects.toThrow('Session interaction response mismatch')
  for (const changed of [{ environmentId: remote() }, { workspaceId: 'other' }, { sessionId: 'other' }]) {
    call.mockResolvedValueOnce(JSON.stringify({ ...results(target)[kind], ...changed }))
    await expect(controller.sessionInteraction(target, request, signal)).rejects.toThrow('Session interaction response mismatch')
  }
  describe.mockResolvedValueOnce(descriptor(target, {}))
  await expect(controller.sessionInteraction(target, request, signal)).rejects.toThrow('does not support Session interactions')
})

it('rejects a download or terminal response that names a different object than requested', async () => {
  const { controller } = await host()
  const target = remote()
  vi.spyOn(PeerTransport.prototype, 'describe').mockResolvedValue(descriptor(target, { workspaceSessionInteractions: true }))
  const call = vi.spyOn(PeerTransport.prototype, 'call')
  const download = interactionRequestSchema.parse({ ...scope, action: 'download', attachmentId: 'file-2' })
  call.mockResolvedValueOnce(JSON.stringify(results(target).download))
  await expect(controller.sessionInteraction(target, download, signal)).rejects.toThrow('Attachment response mismatch')
  const create = interactionRequestSchema.parse({ ...scope, action: 'terminal-create', request: { id: 'term-2', cols: 80, rows: 24 } })
  call.mockResolvedValueOnce(JSON.stringify(results(target).terminal))
  await expect(controller.sessionInteraction(target, create, signal)).rejects.toThrow('Terminal response mismatch')
})

const follow = terminalFollowRequestSchema.parse({ ...scope, terminalId: 'term-1', attachmentId: 'viewer-1' })
const frame = (environmentId: string) => environmentTerminalFrameSchema.parse({ environmentId, ...scope, terminalId: 'term-1', frame: { type: 'output', sequence: 0, data: 'ready' } })

it('follows a local terminal to completion and skips subscriptions that were cancelled before opening', async () => {
  const { controller } = await host()
  const local = (await controller.read()).environmentId
  const output = frame(local)
  const source = vi.spyOn(EnvironmentSessionInteractions.prototype, 'followTerminal').mockImplementation(async function* () { yield output })
  const peer = vi.spyOn(PeerTransport.prototype, 'terminalFollow')
  const cancelled = new AbortController()
  cancelled.abort(new Error('viewer closed'))
  expect((await controller.terminalFollow(local, follow, cancelled.signal)[Symbol.asyncIterator]().next()).done).toBe(true)
  expect(source).not.toHaveBeenCalled()
  const iterator = controller.terminalFollow(local, follow, new AbortController().signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: output })
  expect((await iterator.next()).done).toBe(true)
  expect(peer).not.toHaveBeenCalled()
})

it('follows only the addressed peer terminal and releases a suspended stream on disposal', async () => {
  const { controller, ctx } = await host()
  const target = remote()
  const output = frame(target)
  let finish: () => void = () => undefined
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const peer = vi.spyOn(PeerTransport.prototype, 'terminalFollow').mockImplementation(async function* (_target, _request, active) {
    try {
      yield output
      if (!active.aborted) await new Promise<void>((resolve) => { active.addEventListener('abort', () => { resolve() }, { once: true }) })
    } finally { finish() }
  })
  const local = vi.spyOn(EnvironmentSessionInteractions.prototype, 'followTerminal')
  const iterator = controller.terminalFollow(target, follow, new AbortController().signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: output })
  expect(peer).toHaveBeenCalledWith(target, follow, expect.any(AbortSignal))
  expect(local).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
  await finished
  expect((await iterator.next()).done).toBe(true)
})

it('reports an unavailable pairing service once its provider is disposed', async () => {
  const { controller, mounted } = await host()
  await (await mounted).dispose()
  expect(() => controller.pairingList()).toThrow('Pairing service is unavailable')
})
