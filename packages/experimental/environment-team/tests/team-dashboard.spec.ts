/** Real coordinator storage keeps dashboard reads separate from Agent membership. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { environmentIdSchema, type OperationId, type DistributedTeamId } from '../src/protocol.ts'
import { EnvironmentTeamsProvider } from '../src/team-dashboard.ts'
import { EnvironmentTeams } from '../src/runtime.ts'
import { sessionHost } from './session-host.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const signal = new AbortController().signal
async function fixture() {
  const host = await sessionHost()
  closers.push(host.close)
  const peer = environmentIdSchema.parse(randomUUID())
  host.config.peers.push({ environmentId: peer, url: 'https://peer.example.test', tokenEnv: 'unused',
    workspaces: ['project'], workspaceManagement: false, sessionAccess: false, teamAccess: true, teamOperate: false, attachmentAccess: false, approvalAccess: false, terminalAccess: false })
  const call = vi.fn(async () => JSON.stringify({ status: 'inactive' }))
  const runtime = await EnvironmentTeams.open(host.ctx, host.id, host.config, call)
  closers.push(() => runtime.close())
  const handle = await host.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: host.cwd },
    agentOptions: { provider: 'mock', model: 'mock' } })
  closers.push(() => handle.dispose())
  return { ...host, peer, runtime, call, agent: handle.agent, teamId: brandString<DistributedTeamId>(handle.agent.id) }
}
const operation = () => brandString<OperationId>(randomUUID())

it('reads coordinator records without creating membership or exposing delivery bodies and receipts', async () => {
  const host = await fixture()
  expect(await host.runtime.dashboard(host.id, { action: 'catalog' }, signal)).toMatchObject({ teams: [] })
  await host.runtime.execute(host.agent, operation(), { action: 'list' }, signal)
  await host.runtime.execute(host.agent, operation(), { action: 'task-create', text: 'review destination build' }, signal)
  await host.runtime.execute(host.agent, operation(), { action: 'spawn', name: 'worker',
    environmentId: host.peer, workspace: 'project', text: 'private delivery text' }, signal)
  const result = await host.runtime.dashboard(host.peer, { action: 'read', teamId: host.teamId }, signal)
  expect(result).toMatchObject({ kind: 'team', tasks: [{ text: 'review destination build' }],
    outbox: [{ sender: 'lead', target: 'worker' }] })
  expect(JSON.stringify(result)).not.toContain('private delivery text')
  expect(JSON.stringify(result)).not.toContain('receipts')
  expect(host.call).not.toHaveBeenCalled()
  expect(await host.runtime.dashboard(host.peer, { action: 'catalog' }, signal)).toMatchObject({ teams: [{ members: 2 }] })
  host.config.peers[0]!.workspaces = []
  expect(await host.runtime.dashboard(host.peer, { action: 'catalog' }, signal)).toMatchObject({ teams: [] })
  await expect(host.runtime.dashboard(host.peer, { action: 'read', teamId: host.teamId }, signal)).rejects.toThrow('granted')
  host.config.peers[0]!.teamAccess = false
  await expect(host.runtime.dashboard(host.peer, { action: 'catalog' }, signal)).rejects.toThrow('not granted')
})

it('requires separate interrupt authority and sends coordinator identity without inventing a lead actor', async () => {
  const host = await fixture()
  await host.runtime.execute(host.agent, operation(), { action: 'spawn', name: 'worker',
    environmentId: host.peer, workspace: 'project', text: 'work' }, signal)
  const snapshot = await host.runtime.dashboard(host.id, { action: 'read', teamId: host.teamId }, signal)
  if (snapshot.kind !== 'team') throw new Error('expected team')
  const sessionId = snapshot.members[1]!.sessionId
  const request = { action: 'interrupt', teamId: host.teamId, sessionId } as const
  await expect(host.runtime.dashboard(host.peer, request, signal)).rejects.toThrow('not granted')
  expect(host.call).not.toHaveBeenCalled()
  host.config.peers[0]!.teamOperate = true
  expect(await host.runtime.dashboard(host.peer, request, signal)).toMatchObject({ kind: 'interrupted', sessionId, status: 'inactive' })
  expect(host.call).toHaveBeenCalledWith(host.peer, { kind: 'interrupt', environmentId: host.peer, teamId: host.teamId, sessionId }, expect.any(AbortSignal))
  await expect(host.runtime.dashboard(host.id, { ...request, sessionId: host.agent.id }, signal)).rejects.toThrow('non-lead')
  host.config.maxBytes = 1
  await expect(host.runtime.dashboard(host.id, { action: 'catalog' }, signal)).rejects.toThrow('byte limit')
  const abort = new AbortController()
  abort.abort(new Error('closed viewer'))
  await expect(host.runtime.dashboard(host.id, { action: 'catalog' }, abort.signal)).rejects.toThrow('closed viewer')
})

it('publishes only the live runtime and removes the service with its owning plugin', async () => {
  const host = await fixture()
  const entry = await host.ctx.plugin({
    apply(ctx) { new EnvironmentTeamsProvider(ctx, host.runtime) },
  })
  expect(await host.ctx.environmentTeams.runtime.dashboard(host.id, { action: 'catalog' }, signal)).toMatchObject({ teams: [] })
  await entry.dispose()
  expect(host.ctx.get('environmentTeams')).toBeUndefined()
  expect(await host.runtime.dashboard(host.id, { action: 'catalog' }, signal)).toMatchObject({ teams: [] })
})
