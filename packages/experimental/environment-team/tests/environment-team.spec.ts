/** Independent real HTTP hosts exercise peer authorization and durable team ownership. */
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Workspace from '@deepseek-ai/dsh-workspace'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Plugin from '../src/index.ts'
import { EnvironmentTeams } from '../src/runtime.ts'
import { loadIdentity } from '../src/identity.ts'
import { resolveConfig, type Config } from '../src/config.ts'
import { descriptorSchema, environmentIdSchema, requestSchema } from '../src/protocol.ts'
import type { WorkspaceRequest } from '../src/workspace-types.ts'
import { workspaceResultSchema } from '../src/workspace-protocol.ts'
import { DESCRIPTOR_PATH, PEER_PATH, PeerTransport } from '../src/transport.ts'

const contexts: Context[] = []
const roots: string[] = []
const environmentKeys: string[] = []
const signal = new AbortController().signal
vi.mock('node:fs/promises', { spy: true })

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const key of environmentKeys.splice(0)) Reflect.deleteProperty(process.env, key)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-environment-team-'))
  roots.push(root)
  return root
}

async function host() {
  const root = await temporary()
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, llm: LlmRuntime, sessions: SessionStore, projections: Projections,
    prompt: SystemPrompt, tools: Tools, agents: AgentRegistry, loop: AgentLoop,
    persistence: Persistence, storage: Storage, json: JsonStorage,
    domain: StorageDomain, web: WebServer, environment: Plugin, presets: AgentPresets,
    preset: AgentPreset, workspace: Workspace, credentials: Credentials,
  })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    ...['llm', 'sessions', 'projections', 'prompt', 'tools', 'agents', 'storage'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:persistence', config: { root: join(root, 'sessions') } },
    { name: 'cordis:json', config: { root: join(root, 'storage') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:presets', config: { default: 'test' } },
    { name: 'cordis:preset', config: { id: 'test', plugins: [] } },
    { name: 'cordis:workspace' },
    { name: 'cordis:credentials', config: { path: join(root, 'credentials.yml'), watch: false } },
  ]) + '\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const adapter = new MockAdapter(Array.from({ length: 30 }, () => textResponse('acknowledged')))
  ctx.llm.registerAdapter(['mock'], adapter)
  const id = await loadIdentity(root)
  const config = { stateDirectory: root, label: 'test-host', provider: 'mock', model: 'mock', agentPreset: 'test', sandboxMode: 'workspace-write', approvalPolicy: 'ask', workspaces: { project: cwd }, peers: [] as NonNullable<Config['peers']>, retryIntervalMs: 20 } satisfies Config
  return { ctx, root, cwd, id, config, adapter, url: `http://127.0.0.1:${ctx.webServer.port}` }
}

type Host = Awaited<ReturnType<typeof host>>

async function mount(host: Host, config: Config = host.config) {
  const path = join(host.root, `peers-${randomUUID()}.yml`)
  await writeFile(path, JSON.stringify([{ name: 'cordis:environment', config }]) + '\n')
  const entry = await host.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  try {
    await host.ctx.loader.await()
    for (const item of host.ctx.loader.entries()) await item.fiber?.await()
  } catch (error) {
    const failed = host.ctx.loader.resolve(entry).fiber
    host.ctx.loader.remove(entry)
    await failed?.dispose()
    throw error
  }
  const fiber = host.ctx.loader.resolve(entry).fiber
  if (!fiber) throw new Error('Loader did not activate the peer composition')
  return fiber
}

async function mountedRuntime(host: Host, config: Config = host.config) {
  const factory = EnvironmentTeams.open.bind(EnvironmentTeams)
  let runtime: EnvironmentTeams | undefined
  const capture = vi.spyOn(EnvironmentTeams, 'open').mockImplementation(async (...args) => {
    runtime = await factory(...args)
    return runtime
  })
  try {
    const fiber = await mount(host, config)
    if (!runtime) throw new Error('runtime did not activate')
    return { runtime, fiber }
  } finally { capture.mockRestore() }
}

function pair(left: Host, right: Host) {
  const key = `DSH_TEST_PEER_${randomUUID().replaceAll('-', '_')}`
  environmentKeys.push(key)
  process.env[key] = randomUUID() + randomUUID()
  left.config.peers = [{ environmentId: right.id, url: right.url, tokenEnv: key, workspaces: ['project'] }]
  right.config.peers = [{ environmentId: left.id, url: left.url, tokenEnv: key, workspaces: ['project'] }]
  return key
}

async function execute(host: Host, agent: Agent, args: object, call: string = randomUUID()) {
  const result = await host.ctx.tools.execute({ callId: ToolCallId(call), name: 'environment_team', arguments: args, agent, signal })
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  return { result, text }
}

async function lead(host: Host) {
  return (await host.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: host.cwd }, agentOptions: { provider: 'mock', model: 'mock' } })).agent
}

describe('environment identity', () => {
  it('converges concurrent initializers and preserves identity on restart', async () => {
    const root = await temporary()
    const ids = await Promise.all(Array.from({ length: 12 }, () => loadIdentity(root)))
    expect(new Set(ids).size).toBe(1)
    expect(await loadIdentity(root)).toBe(ids[0])
    expect((await readFile(join(root, 'environment-id'), 'utf8')).trim()).toBe(ids[0])
  })

  it('refuses corrupt identity without replacing it', async () => {
    const root = await temporary()
    await writeFile(join(root, 'environment-id'), 'broken')
    await expect(loadIdentity(root)).rejects.toThrow()
    expect(await readFile(join(root, 'environment-id'), 'utf8')).toBe('broken')
  })
})

describe('distributed teams', () => {
  it('keeps spawn queued while the receiver is offline, then creates exactly one remote Session', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    await mount(a)
    let attempts = 0
    const offline = b.ctx.webServer.register({ kind: 'exact', path: DESCRIPTOR_PATH, handler(_request, response) { attempts++; response.writeHead(503).end() } })
    const rootAgent = await lead(a)
    const args = { action: 'spawn', name: 'worker', environmentId: b.id, workspace: 'project', text: 'Inspect this checkout.' }
    const first = await execute(a, rootAgent, args, 'spawn-once')
    const retry = await execute(a, rootAgent, args, 'spawn-once')
    expect(first.text).toBe(retry.text)
    const spawned = JSON.parse(first.text) as { member: { sessionId: string } }
    expect(spawned.member.sessionId).toBeTruthy()
    expect(b.ctx.agents.list()).toHaveLength(0)
    await expect.poll(() => attempts).toBeGreaterThan(0)
    offline()
    const bFiber = await mount(b)
    await expect.poll(() => b.ctx.agents.list().length).toBe(1)
    const worker = b.ctx.agents.get(SessionId(spawned.member.sessionId))!
    await expect.poll(() => b.adapter.requests.length).toBe(1)
    await worker.whenIdle()
    expect(worker.session.header.cwd).toBe(b.cwd)
    expect(worker.session.header.agentPreset).toBe('test')
    expect((await b.ctx.workspaceRegistry.create(b.cwd)).sessionIds).toContain(worker.id)
    expect(b.ctx.agentPresets.composedPreset(worker.ctx)).toBe('test')
    await expect.poll(async () => (await execute(a, rootAgent, { action: 'list' })).text).toContain('"queuedMessages":0')
    expect(a.ctx.agents.list()).toHaveLength(1)
    expect((await execute(a, rootAgent, { ...args, text: 'Changed arguments' }, 'spawn-once')).text).toContain('reused')
    const task = JSON.parse((await execute(b, worker, { action: 'task-create', text: 'Review changes' })).text) as { id: string; revision: number }
    const claim = { action: 'task-update', taskId: task.id, revision: 1, status: 'in_progress' }
    expect((await execute(b, worker, claim)).text).toContain('"owner":"worker"')
    expect((await execute(a, rootAgent, claim)).text).toContain('stale task revision')
    expect((await execute(b, worker, { action: 'spawn', name: 'forbidden', environmentId: a.id, workspace: 'project', text: 'No' })).text).toContain('403')
    expect((await execute(b, worker, { action: 'send', target: 'lead', text: 'Review complete.' })).text).toContain('queued')
    await expect.poll(() => a.adapter.requests.length).toBe(1)
    await rootAgent.whenIdle()
    await bFiber.dispose()
    expect(b.ctx.agents.get(worker.id)).toBeUndefined()
    await mount(b)
    expect((await execute(a, rootAgent, { action: 'send', target: 'worker', text: 'Resume review.' })).text).toContain('queued')
    await expect.poll(() => b.ctx.agents.get(worker.id)).toBeDefined()
    await expect.poll(() => b.adapter.requests.length).toBe(2)
    await b.ctx.agents.get(worker.id)!.whenIdle()
    expect(b.ctx.agents.list()).toHaveLength(1)
    expect(b.adapter.requests).toHaveLength(2)
  })

  it('rejects browser requests, ungranted actors, mismatched identities, and revoked peers', async () => {
    const a = await host()
    const b = await host()
    const key = pair(a, b)
    const fiber = await mount(a)
    const headers = { authorization: `Bearer ${process.env[key]}`, 'content-type': 'application/json' }
    const post = (body: object, extra: Record<string, string> = {}) => fetch(`${a.url}${PEER_PATH}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
    const body = { kind: 'command', environmentId: a.id, teamId: randomUUID(), actor: randomUUID(), operationId: 'request', command: { action: 'list' } }
    expect((await post(body, { origin: a.url })).status).toBe(401)
    expect((await post(body, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await post({ ...body, environmentId: b.id })).status).toBe(409)
    expect((await post(body)).status).toBe(403)
    const descriptor = descriptorSchema.parse(await (await fetch(`${a.url}${DESCRIPTOR_PATH}`)).json())
    expect(descriptor.environmentId).toBe(a.id)
    await fiber.dispose()
    await mount(a, { ...a.config, peers: [] })
    expect((await post(body)).status).toBe(401)
  })

  it('refuses identity substitution before sending the peer credential', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    await mount(a)
    const wrongId = environmentIdSchema.parse(randomUUID())
    const transport = new PeerTransport(b.id, resolveConfig({
      ...b.config, peers: [{ ...b.config.peers[0]!, environmentId: wrongId, url: a.url }],
    }), b.ctx.credentials)
    const request = requestSchema.parse({ kind: 'interrupt', environmentId: wrongId, teamId: randomUUID(), sessionId: 'x' })
    await expect(transport.call(wrongId, request, signal)).rejects.toThrow('identity mismatch')
  })

  it('accepts a repeated delivery once, including after receiver restart', async () => {
    const a = await host()
    const b = await host()
    const key = pair(a, b)
    const fiber = await mount(b)
    const sessionId = randomUUID()
    const assignment = { coordinator: a.id, teamId: randomUUID(), member: { environmentId: b.id, sessionId, name: 'worker', workspace: 'project' } }
    const input = { kind: 'deliver', environmentId: b.id, assignment, message: { id: 'delivery-once', sender: 'lead', target: 'worker', text: 'Do this once.' } }
    const deliver = (body: object = input) => fetch(`${b.url}${PEER_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${process.env[key]}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const responses = await Promise.all([deliver(), deliver()])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    const worker = b.ctx.agents.get(SessionId(sessionId))!
    await worker.whenIdle()
    expect(b.adapter.requests).toHaveLength(1)
    const checkpoint = b.ctx.sessionProjections.checkpoint(worker.session)
    const row = checkpoint.environmentTeamReceipts!
    const restored = b.ctx.sessionProjections.restore(
      checkpoint, [], SessionLogOffset(row.seq + 1), worker.session.header, SessionLogOffset(0),
    )
    expect(restored.checkpoint.environmentTeamReceipts).toEqual(row)
    await fiber.dispose()
    const withoutProducer = await b.ctx.sessionPersistence.open(worker.id, 'read')
    try {
      const messages = (await withoutProducer.read()).events.filter(event => event.type === 'user/message')
      expect(messages[0]!.data.source).toEqual({ kind: 'environment-team', coordinator: a.id, teamId: assignment.teamId, sender: 'lead' })
    } finally { await withoutProducer.close() }
    await mount(b)
    expect((await deliver()).status).toBe(200)
    await b.ctx.agents.get(worker.id)!.whenIdle()
    expect(b.adapter.requests).toHaveLength(1)
    expect((await deliver({ ...input, assignment: { ...assignment, member: { ...assignment.member, workspace: 'ungranted' } } })).status).toBe(403)
    expect((await deliver({ ...input, assignment: { ...assignment, coordinator: b.id } })).status).toBe(403)
    const record = await b.ctx.sessionPersistence.open(worker.id, 'read')
    try {
      const events = (await record.read()).events
      const messages = events.filter(event => event.type === 'user/message')
      expect(messages).toHaveLength(1)
      expect(messages[0]!.data.source).toEqual({ kind: 'environment-team', coordinator: a.id, teamId: assignment.teamId, sender: 'lead' })
    } finally { await record.close() }
  })

  it('keeps concurrent task claims exclusive and enforces task ownership', async () => {
    const a = await host()
    await mount(a)
    const root = await lead(a)
    const spawned = JSON.parse((await execute(a, root, { action: 'spawn', name: 'worker', environmentId: a.id, workspace: 'project', text: 'Help.' })).text) as { member: { sessionId: string } }
    await expect.poll(() => a.ctx.agents.get(SessionId(spawned.member.sessionId))).toBeDefined()
    const worker = a.ctx.agents.get(SessionId(spawned.member.sessionId))!
    await worker.whenIdle()
    const task = JSON.parse((await execute(a, root, { action: 'task-create', text: 'Shared work' })).text) as { id: string }
    expect((await execute(a, worker, { action: 'task-update', taskId: task.id, revision: 1, status: 'completed' })).text).toContain('claim')
    const args = { action: 'task-update', taskId: task.id, revision: 1, status: 'in_progress' }
    const claims = await Promise.all([execute(a, root, args), execute(a, worker, args)])
    expect(claims.filter(result => result.text.includes('stale task revision'))).toHaveLength(1)
    expect((await execute(a, worker, { ...args, revision: 2, status: 'completed' })).text).toContain('owned by another')
    expect((await execute(a, root, { ...args, revision: 2, status: 'completed' })).text).toContain('completed')
    expect((await execute(a, root, { ...args, revision: 3, status: 'pending' })).text).not.toContain('owner')
    expect((await execute(a, root, { action: 'interrupt', target: 'worker' })).text).toContain('interrupt-requested')
    expect((await execute(a, worker, { action: 'interrupt', target: 'lead' })).text).toContain('only the lead')
  })

  it('coordinates four independent workers from a fifth environment', async () => {
    const coordinator = await host()
    const workers = await Promise.all(Array.from({ length: 4 }, () => host()))
    const grants: NonNullable<Config['peers']> = []
    for (const worker of workers) {
      pair(coordinator, worker)
      grants.push(...coordinator.config.peers)
    }
    coordinator.config.peers = grants
    await mount(coordinator)
    for (const worker of workers) await mount(worker)
    const root = await lead(coordinator)
    await Promise.all(workers.map((worker, index) => execute(coordinator, root, {
      action: 'spawn', name: `worker-${index}`, environmentId: worker.id, workspace: 'project', text: 'Inspect your own checkout.',
    })))
    for (const worker of workers) {
      await expect.poll(() => worker.ctx.agents.list().length).toBe(1)
      const agent = worker.ctx.agents.list()[0]!
      await agent.whenIdle()
      expect(agent.session.header.cwd).toBe(worker.cwd)
    }
    const view = JSON.parse((await execute(coordinator, root, { action: 'list' })).text) as { members: object[] }
    expect(view.members).toHaveLength(5)
  })
})

describe('peer configuration', () => {
  it('requires encrypted non-loopback endpoints and unique peer identities', async () => {
    const a = await host()
    const peer = { environmentId: randomUUID(), url: 'http://100.64.0.1:3000', tokenEnv: 'UNUSED', workspaces: ['project'] }
    expect(() => resolveConfig({ ...a.config, peers: [peer] })).toThrow('HTTPS')
    const secure = { ...peer, url: 'https://host.example' }
    expect(() => resolveConfig({ ...a.config, peers: [secure, secure] })).toThrow('duplicate')
    expect(() => resolveConfig({ ...a.config, peers: [{ ...secure, url: 'https://user:pass@host.example' }] })).toThrow('origin')
    await expect(new PeerTransport(a.id, resolveConfig({ ...a.config, peers: [secure] }), a.ctx.credentials).tokens()).rejects.toThrow('32 bytes')
  })
})


describe('deployment and admission limits', () => {
  it('lists only public configuration and rejects unauthenticated browser and malformed requests', async () => {
    const a = await host()
    const b = await host()
    const key = pair(a, b)
    await mount(a, { ...a.config, maxBytes: 500 })
    const list = await a.ctx.tools.execute({ callId: ToolCallId('list'), name: 'environment_list', arguments: {}, signal })
    const text = JSON.stringify(list.content)
    expect(text).toContain(b.id)
    expect(text).not.toContain(process.env[key])
    expect(text).not.toContain(a.cwd.replaceAll('\\', '\\\\'))
    const absent = await a.ctx.tools.execute({ callId: ToolCallId('absent'), name: 'environment_team', arguments: { action: 'list' }, signal })
    expect(JSON.stringify(absent.content)).toContain('requires an Agent')
    expect((await fetch(`${a.url}${DESCRIPTOR_PATH}`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${a.url}${PEER_PATH}`)).status).toBe(401)
    const headers = { authorization: `Bearer ${process.env[key]}`, 'content-type': 'application/json' }
    expect((await fetch(`${a.url}${PEER_PATH}`, { headers })).status).toBe(415)
    expect((await fetch(`${a.url}${PEER_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
    expect((await fetch(`${a.url}${PEER_PATH}`, { method: 'POST', headers, body: '{}' })).status).toBe(400)
    expect((await fetch(`${a.url}${PEER_PATH}`, { method: 'POST', headers, body: '{' })).status).toBe(403)
    expect((await fetch(`${a.url}${PEER_PATH}`, { method: 'POST', headers, body: 'x'.repeat(501) })).status).toBe(413)
  })

  it('rejects exhausted teams, members, tasks, and retained operation capacity', async () => {
    const a = await host()
    await mount(a, { ...a.config, maxTeams: 1, maxMembers: 1, maxTasks: 1, maxOperations: 2 })
    const root = await lead(a)
    const other = await lead(a)
    expect((await execute(a, root, { action: 'list' })).result.isError).not.toBe(true)
    expect((await execute(a, other, { action: 'list' })).text).toContain('team limit')
    expect((await execute(a, root, { action: 'spawn', name: 'worker', environmentId: a.id, workspace: 'project', text: 'work' })).text).toContain('member limit')
    expect((await execute(a, root, { action: 'send', target: 'missing', text: 'hello' })).text).toContain('target member not found')
    expect((await execute(a, root, { action: 'interrupt', target: 'missing' })).text).toContain('teammate not found')
    expect((await execute(a, root, { action: 'task-update', taskId: 'missing', revision: 1, status: 'pending' })).text).toContain('task not found')
    const task = JSON.parse((await execute(a, root, { action: 'task-create', text: 'one' })).text) as { id: string }
    expect((await execute(a, root, { action: 'task-create', text: 'two' })).text).toContain('task limit')
    expect((await execute(a, root, { action: 'task-update', taskId: task.id, revision: 1, status: 'in_progress' })).text).toContain('in_progress')
    expect((await execute(a, root, { action: 'task-update', taskId: task.id, revision: 2, status: 'completed' })).text).toContain('retention limit')
  })

  it('rejects unconfigured workspaces, duplicate member names, and oversized durable state', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    await mount(a, { ...a.config, maxBytes: 1800, retryIntervalMs: 60000 })
    const root = await lead(a)
    const wrong = (await a.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: a.root }, agentOptions: { provider: 'mock', model: 'mock' } })).agent
    expect((await execute(a, wrong, { action: 'list' })).text).toContain('cwd must match')
    const spawn = { action: 'spawn', name: 'worker', environmentId: a.id, workspace: 'missing', text: 'work' }
    expect((await execute(a, root, spawn)).text).toContain('alias is not configured')
    expect((await execute(a, root, { ...spawn, environmentId: b.id, workspace: 'missing' })).text).toContain('not granted')
    expect((await execute(a, root, { ...spawn, environmentId: b.id, workspace: 'project' })).text).toContain('queued')
    expect((await execute(a, root, { ...spawn, environmentId: b.id, workspace: 'project' })).text).toContain('name already exists')
    expect((await execute(a, root, { action: 'task-create', text: 'x'.repeat(1800) })).text).toContain('state byte limit')
    expect((await execute(a, root, { action: 'list' })).text).toContain('"tasks":[]')
  })

  it('keeps a persisted storage domain bound to its original environment identity', async () => {
    const a = await host()
    const fiber = await mount(a)
    await fiber.dispose()
    await writeFile(join(a.root, 'environment-id'), `${randomUUID()}\n`)
    await expect(mount(a)).rejects.toThrow('different environment')
  })

  it('rejects self-pairing, shared pair secrets, and missing peer routes', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    const grant = a.config.peers[0]!
    await expect(new PeerTransport(a.id, resolveConfig({ ...a.config, peers: [{ ...grant, environmentId: a.id }] }), a.ctx.credentials).tokens()).rejects.toThrow('itself')
    await expect(new PeerTransport(a.id, resolveConfig({ ...a.config, peers: [grant, { ...grant, environmentId: randomUUID() }] }), a.ctx.credentials).tokens()).rejects.toThrow('distinct credential')
    const transport = new PeerTransport(a.id, resolveConfig(a.config), a.ctx.credentials)
    const request = requestSchema.parse({ kind: 'interrupt', environmentId: b.id, teamId: 'team', sessionId: 'member' })
    await expect(transport.call(a.id, request, signal)).rejects.toThrow('not configured')
    await expect(transport.call(b.id, request, signal)).rejects.toThrow('descriptor is unavailable')
    await mount(b)
    const limited = new PeerTransport(a.id, resolveConfig({ ...a.config, maxBytes: 300 }), a.ctx.credentials)
    const large = requestSchema.parse({ kind: 'command', environmentId: b.id, teamId: 'team', actor: 'member', operationId: 'op', command: { action: 'task-create', text: 'x'.repeat(500) } })
    await expect(limited.call(b.id, large, signal)).rejects.toThrow('request byte limit')
    const tiny = new PeerTransport(a.id, resolveConfig({ ...a.config, maxBytes: 10 }), a.ctx.credentials)
    await expect(tiny.call(b.id, request, signal)).rejects.toThrow('response byte limit')
  })
})


describe('receiver ownership', () => {
  it('refuses assignment substitution, existing Session capture, and capacity overflow', async () => {
    const a = await host()
    const b = await host()
    const key = pair(a, b)
    await mount(b, { ...b.config, maxTeams: 1, maxMembers: 1 })
    const send = async (sessionId: string, workspace = 'project', teamId = 'team') => {
      const response = await fetch(`${b.url}${PEER_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${process.env[key]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'deliver', environmentId: b.id,
          assignment: { coordinator: a.id, teamId, member: { environmentId: b.id, sessionId, name: 'worker', workspace } },
          message: { id: 'op', sender: 'lead', target: 'worker', text: 'work' } }),
      })
      await response.text()
      return response.status
    }
    const own = await lead(b)
    expect(await send(own.id)).toBe(403)
    const acceptedId = randomUUID()
    expect(await send(acceptedId)).toBe(200)
    await b.ctx.agents.get(SessionId(acceptedId))!.whenIdle()
    expect(await send(acceptedId, 'project', 'different-team')).toBe(403)
    expect(await send(randomUUID())).toBe(403)
    const interrupt = await fetch(`${b.url}${PEER_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${process.env[key]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'interrupt', environmentId: b.id, teamId: 'wrong-team', sessionId: acceptedId }),
    })
    expect(interrupt.status).toBe(403)
  })

  it('refuses a grant for an alias that has no local mapping', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    b.config.peers[0]!.workspaces.push('absent')
    await mount(b)
    const transport = new PeerTransport(a.id, resolveConfig(a.config), a.ctx.credentials)
    const request = requestSchema.parse({ kind: 'deliver', environmentId: b.id,
      assignment: { coordinator: a.id, teamId: 'team', member: { environmentId: b.id, sessionId: randomUUID(), name: 'worker', workspace: 'absent' } },
      message: { id: 'op', sender: 'lead', target: 'worker', text: 'work' } })
    await expect(transport.call(b.id, request, signal)).rejects.toThrow('403')
  })

  it('rejects workspace files before acquiring ownership', async () => {
    const a = await host()
    const file = join(a.root, 'not-a-directory')
    await writeFile(file, 'data')
    await expect(mount(a, { ...a.config, workspaces: { project: file } })).rejects.toThrow('must be a directory')
  })

  it('rejects live calls after close and prevents foreign actors from addressing a local team', async () => {
    const a = await host()
    const factory = EnvironmentTeams.open.bind(EnvironmentTeams)
    let runtime: EnvironmentTeams | undefined
    const capture = vi.spyOn(EnvironmentTeams, 'open').mockImplementation(async (...args) => {
      runtime = await factory(...args)
      return runtime
    })
    const fiber = await mount(a)
    capture.mockRestore()
    if (!runtime) throw new Error('runtime did not activate')
    const root = await lead(a)
    const view = JSON.parse((await execute(a, root, { action: 'list' })).text) as { teamId: string }
    const request = requestSchema.parse({ kind: 'command', environmentId: a.id, teamId: view.teamId, actor: 'foreign', operationId: 'op', command: { action: 'list' } })
    await expect(runtime.receive(a.id, request)).rejects.toThrow('not a member')
    await expect(runtime.receive(a.id, { ...request, environmentId: environmentIdSchema.parse(randomUUID()) })).rejects.toThrow('identity mismatch')
    if (request.kind !== 'command') throw new Error('expected command')
    const abort = new AbortController()
    abort.abort(new Error('canceled'))
    await expect(runtime.execute(root, request.operationId, request.command, abort.signal)).rejects.toThrow('canceled')
    await fiber.dispose()
    await expect(runtime.pump()).resolves.toBeUndefined()
    await expect(runtime.receive(a.id, request)).rejects.toThrow('stopping')
  })
})


describe('restart and transport failures', () => {
  it('preserves queued work and tasks across coordinator restart', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    const fiber = await mount(a, { ...a.config, retryIntervalMs: 60000 })
    const root = await lead(a)
    const spawn = { action: 'spawn', name: 'worker', environmentId: b.id, workspace: 'project', text: 'First message.' }
    const before = await execute(a, root, spawn, 'stable-spawn')
    await execute(a, root, { action: 'send', target: 'worker', text: 'Second message.' })
    await execute(a, root, { action: 'task-create', text: 'Survive restart' })
    await fiber.dispose()
    await mount(a)
    expect((await execute(a, root, spawn, 'stable-spawn')).text).toBe(before.text)
    expect((await execute(a, root, { action: 'list' })).text).toContain('Survive restart')
    await mount(b)
    await expect.poll(async () => (await execute(a, root, { action: 'list' })).text).toContain('"queuedMessages":0')
    const worker = b.ctx.agents.list()[0]!
    await worker.whenIdle()
    const record = await b.ctx.sessionPersistence.open(worker.id, 'read')
    try {
      const inputs = (await record.read()).events.filter(event => event.type === 'user/message')
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[0])).toContain('First message.')
      expect(JSON.stringify(inputs[1])).toContain('Second message.')
    } finally { await record.close() }
    expect((await execute(a, root, { action: 'interrupt', target: 'worker' })).text).toContain('interrupt-requested')
  })

  it('refuses foreign persisted assignments and releases the store after failed activation', async () => {
    const a = await host()
    const fiber = await mount(a)
    const root = await lead(a)
    await execute(a, root, { action: 'list' })
    await fiber.dispose()
    const file = join(a.root, 'storage', 'environment_teams', 'assignments', `${root.id}.json`)
    const original = await readFile(file, 'utf8')
    const corrupted = JSON.parse(original) as { record: { member: { environmentId: string } } }
    corrupted.record.member.environmentId = randomUUID()
    await writeFile(file, JSON.stringify(corrupted))
    await expect(mount(a)).rejects.toThrow('assignments belong to a different environment')
    await writeFile(file, original)
    await mount(a)
    expect((await execute(a, root, { action: 'list' })).result.isError).not.toBe(true)
  })

  it('rejects empty descriptors and response identity substitution', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    const transport = new PeerTransport(a.id, resolveConfig(a.config), a.ctx.credentials)
    const input = requestSchema.parse({ kind: 'interrupt', environmentId: b.id, teamId: 'team', sessionId: 'worker' })
    const empty = b.ctx.webServer.register({ kind: 'exact', path: DESCRIPTOR_PATH, handler(_request, response) { response.writeHead(204).end() } })
    await expect(transport.call(b.id, input, signal)).rejects.toThrow('no body')
    empty()
    b.ctx.effect(() => b.ctx.webServer.register({ kind: 'exact', path: DESCRIPTOR_PATH, handler(_request, response) {
      response.end(JSON.stringify({ environmentId: b.id, label: 'peer', platform: 'test', protocol: 1, capabilities: { distributedTeams: true } }))
    } }))
    b.ctx.effect(() => b.ctx.webServer.register({ kind: 'exact', path: PEER_PATH, handler(_request, response) {
      response.end(JSON.stringify({ environmentId: a.id, result: 'foreign' }))
    } }))
    await expect(transport.call(b.id, input, signal)).rejects.toThrow('response identity mismatch')
  })
})


it('releases storage after the initial identity write fails', async () => {
  const a = await host()
  const kv = a.ctx.storage.backend.get('json').kv!
  const open = kv.open.bind(kv)
  const failure = vi.spyOn(kv, 'open').mockImplementation(async (spec) => {
    const unit = await open(spec)
    vi.spyOn(unit, 'setGlobal').mockRejectedValueOnce(new Error('storage unavailable'))
    return unit
  })
  await expect(mount(a)).rejects.toThrow('storage unavailable')
  failure.mockRestore()
  await mount(a)
  expect((await fetch(`${a.url}${DESCRIPTOR_PATH}`)).status).toBe(200)
})


it('closes a peer request that stalls while sending its body', async () => {
  const a = await host()
  const b = await host()
  const key = pair(a, b)
  await mount(b, { ...b.config, requestTimeoutMs: 50 })
  const socket = createConnection({ host: '127.0.0.1', port: b.ctx.webServer.port })
  const errors: Error[] = []
  socket.on('error', error => errors.push(error))
  try {
    await once(socket, 'connect')
    const closed = new Promise<void>(resolve => socket.once('close', () => { resolve() }))
    socket.write(`POST ${PEER_PATH} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${process.env[key]}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`)
    await closed
    expect(socket.destroyed).toBe(true)
  } finally { socket.destroy() }
})

it('continues retry scheduling after a failed retry pass', async () => {
  const a = await host()
  const pump = vi.spyOn(EnvironmentTeams.prototype, 'pump').mockRejectedValueOnce(new Error('retry unavailable'))
  await mount(a)
  await expect.poll(() => pump.mock.calls.length).toBeGreaterThan(1)
  pump.mockRestore()
  expect((await fetch(`${a.url}${DESCRIPTOR_PATH}`)).status).toBe(200)
})


it('keeps ordinary user input outside delivery receipts and rejects a disposed caller', async () => {
  const a = await host()
  const { runtime } = await mountedRuntime(a)
  const handle = await a.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: a.cwd }, agentOptions: { provider: 'mock', model: 'mock' } })
  handle.agent.steer({ id: MessageId(randomUUID()), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary input' }] })
  await handle.agent.whenIdle()
  expect(a.ctx.sessionProjections.stateOf(handle.agent.session, 'environmentTeamReceipts')).toEqual([])
  await handle.dispose()
  const request = requestSchema.parse({ kind: 'command', environmentId: a.id, teamId: 'team', actor: handle.agent.id, operationId: 'op', command: { action: 'list' } })
  if (request.kind !== 'command') throw new Error('expected command')
  await expect(runtime.execute(handle.agent, request.operationId, request.command, signal)).rejects.toThrow('not a live local Agent')
})

it('rejects oversized framed messages before creating Sessions and bounds HTTP output', async () => {
  const a = await host()
  const b = await host()
  const key = pair(a, b)
  const { runtime } = await mountedRuntime(b, { ...b.config, maxBytes: 512 })
  const input = requestSchema.parse({ kind: 'deliver', environmentId: b.id,
    assignment: { coordinator: a.id, teamId: 'team', member: { environmentId: b.id, sessionId: randomUUID(), name: 'worker', workspace: 'project' } },
    message: { id: 'op', sender: 'lead', target: 'worker', text: 'x'.repeat(512) } })
  await expect(runtime.receive(a.id, input)).rejects.toThrow('message byte limit')
  expect(b.ctx.agents.list()).toHaveLength(0)
  vi.spyOn(runtime, 'receive').mockResolvedValueOnce('x'.repeat(512))
  const response = await fetch(`${b.url}${PEER_PATH}`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env[key]}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'interrupt', environmentId: b.id, teamId: 'team', sessionId: 'worker' }),
  })
  expect(response.status).toBe(413)
})

it('requires recorded receipt acceptance and recovers without delivering twice', async () => {
  const a = await host()
  const b = await host()
  pair(a, b)
  const { runtime } = await mountedRuntime(b)
  const input = requestSchema.parse({ kind: 'deliver', environmentId: b.id,
    assignment: { coordinator: a.id, teamId: 'team', member: { environmentId: b.id, sessionId: randomUUID(), name: 'worker', workspace: 'project' } },
    message: { id: 'op', sender: 'lead', target: 'worker', text: 'work' } })
  const stateOf = b.ctx.sessionProjections.stateOf.bind(b.ctx.sessionProjections)
  const projection = vi.spyOn(b.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) =>
    key === 'environmentTeamReceipts' ? undefined : stateOf(session, key))
  await expect(runtime.receive(a.id, input)).rejects.toThrow('projection is unavailable')
  let reads = 0
  projection.mockImplementation((session, key) => {
    if (key === 'environmentTeamReceipts' && ++reads === 2) return undefined
    return stateOf(session, key)
  })
  await expect(runtime.receive(a.id, input)).rejects.toThrow('acceptance was not recorded')
  projection.mockRestore()
  await expect(runtime.receive(a.id, input)).resolves.toContain('accepted')
  const worker = b.ctx.agents.list()[0]!
  await worker.whenIdle()
  expect(b.adapter.requests).toHaveLength(1)
})


it('keeps each offline target ordered and recovers an orphan coordinator record', async () => {
  const a = await host()
  const b = await host()
  pair(a, b)
  const { runtime, fiber } = await mountedRuntime(a, { ...a.config, retryIntervalMs: 60000 })
  const root = await lead(a)
  await execute(a, root, { action: 'spawn', name: 'worker', environmentId: b.id, workspace: 'project', text: 'first' })
  await execute(a, root, { action: 'send', target: 'worker', text: 'second' })
  let attempts = 0
  b.ctx.effect(() => b.ctx.webServer.register({ kind: 'exact', path: DESCRIPTOR_PATH, handler(_request, response) { attempts++; response.writeHead(503).end() } }))
  await runtime.pump()
  expect(attempts).toBe(1)
  const unavailable = vi.spyOn(PeerTransport.prototype, 'call').mockRejectedValueOnce('offline')
  await runtime.pump()
  unavailable.mockRestore()
  expect((await execute(a, root, { action: 'list' })).text).toContain('"queuedMessages":2')
  await fiber.dispose()
  await rm(join(a.root, 'storage', 'environment_teams', 'assignments', `${root.id}.json`))
  await mount(a, { ...a.config, retryIntervalMs: 60000 })
  expect((await execute(a, root, { action: 'list' })).text).toContain('"queuedMessages":2')
})

it('refuses changed workspace mappings for both dormant and live members', async () => {
  const a = await host()
  const b = await host()
  pair(a, b)
  const first = await mountedRuntime(b)
  const sessionId = SessionId(randomUUID())
  const input = requestSchema.parse({ kind: 'deliver', environmentId: b.id,
    assignment: { coordinator: a.id, teamId: 'team', member: { environmentId: b.id, sessionId, name: 'worker', workspace: 'project' } },
    message: { id: 'op', sender: 'lead', target: 'worker', text: 'work' } })
  await first.runtime.receive(a.id, input)
  await b.ctx.agents.get(sessionId)!.whenIdle()
  await first.fiber.dispose()
  const second = await mountedRuntime(b, { ...b.config, workspaces: { project: b.root } })
  await expect(second.runtime.receive(a.id, input)).rejects.toThrow('stored member workspace differs')
  const interrupt = requestSchema.parse({ kind: 'interrupt', environmentId: b.id, teamId: 'team', sessionId })
  await expect(second.runtime.receive(a.id, interrupt)).resolves.toContain('inactive')
  const handle = await b.ctx.agents.resume({ resumeSessionId: sessionId })
  try { await expect(second.runtime.receive(a.id, input)).rejects.toThrow('live member workspace differs') }
  finally { await handle.dispose() }
})

it('drains an in-flight local delivery before closing and leaves later work queued', async () => {
  const a = await host()
  const { runtime } = await mountedRuntime(a, { ...a.config, retryIntervalMs: 60000 })
  const root = await lead(a)
  await execute(a, root, { action: 'spawn', name: 'worker', environmentId: a.id, workspace: 'project', text: 'first' })
  await execute(a, root, { action: 'send', target: 'worker', text: 'second' })
  const flush = a.ctx.sessions.flush.bind(a.ctx.sessions)
  let closing: Promise<void> | undefined
  const gate = vi.spyOn(a.ctx.sessions, 'flush').mockImplementation(async (session) => {
    const flushed = await flush(session)
    gate.mockRestore()
    closing = runtime.close()
    return flushed
  })
  await runtime.pump()
  await closing
  const file = join(a.root, 'storage', 'environment_teams', 'teams', `${root.id}.json`)
  const state = JSON.parse(await readFile(file, 'utf8')) as { record: { pending: { text: string }[] } }
  expect(state.record.pending.map(item => item.text)).toEqual(['second'])
})

it('closes the store even when a member disposer reports failure', async () => {
  const a = await host()
  const { runtime } = await mountedRuntime(a, { ...a.config, retryIntervalMs: 60000 })
  const root = await lead(a)
  await execute(a, root, { action: 'spawn', name: 'worker', environmentId: a.id, workspace: 'project', text: 'work' })
  const create = a.ctx.agents.create.bind(a.ctx.agents)
  const allocation = vi.spyOn(a.ctx.agents, 'create').mockImplementation(async (request) => {
    const handle = await create(request)
    const dispose = handle.dispose.bind(handle)
    vi.spyOn(handle, 'dispose').mockImplementation(async () => { await dispose(); throw new Error('disposal failed') })
    return handle
  })
  await runtime.pump()
  allocation.mockRestore()
  await expect(runtime.close()).rejects.toThrow('members failed to dispose')
  await expect(runtime.close()).resolves.toBeUndefined()
})


it('rejects a persisted outbox whose target is absent from the roster', async () => {
  const a = await host()
  const first = await mountedRuntime(a, { ...a.config, retryIntervalMs: 60000 })
  const root = await lead(a)
  await execute(a, root, { action: 'send', target: 'lead', text: 'work' })
  await first.fiber.dispose()
  const path = join(a.root, 'storage', 'environment_teams', 'teams', `${root.id}.json`)
  const state = JSON.parse(await readFile(path, 'utf8')) as { record: { pending: { target: string }[] } }
  state.record.pending[0]!.target = 'absent'
  await writeFile(path, JSON.stringify(state))
  const second = await mountedRuntime(a, { ...a.config, retryIntervalMs: 60000 })
  await expect(second.runtime.pump()).rejects.toThrow('no roster target')
})

it('aborts an in-flight peer connection and retains delivery during shutdown', async () => {
  const a = await host()
  const b = await host()
  pair(a, b)
  let started!: () => void
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  b.ctx.effect(() => b.ctx.webServer.register({ kind: 'exact', path: DESCRIPTOR_PATH, handler() { started() } }))
  const { runtime } = await mountedRuntime(a, { ...a.config, retryIntervalMs: 60000 })
  const root = await lead(a)
  await execute(a, root, { action: 'spawn', name: 'worker', environmentId: b.id, workspace: 'project', text: 'work' })
  const pumping = runtime.pump()
  await requestStarted
  await runtime.close()
  await pumping
  const path = join(a.root, 'storage', 'environment_teams', 'teams', `${root.id}.json`)
  const state = JSON.parse(await readFile(path, 'utf8')) as { record: { pending: object[] } }
  expect(state.record.pending).toHaveLength(1)
})

it('refuses a durable assignment whose Session has no recorded preset', async () => {
  const a = await host()
  const b = await host()
  pair(a, b)
  const handle = await b.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: b.cwd } })
  const sessionId = handle.agent.id
  await b.ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
  const first = await mountedRuntime(b)
  await first.fiber.dispose()
  const assignment = { coordinator: a.id, teamId: 'team', member: { environmentId: b.id, sessionId, name: 'worker', workspace: 'project' } }
  await mkdir(join(b.root, 'storage', 'environment_teams', 'assignments'), { recursive: true })
  await writeFile(join(b.root, 'storage', 'environment_teams', 'assignments', `${sessionId}.json`), JSON.stringify({ version: 1, record: assignment }))
  const second = await mountedRuntime(b)
  const input = requestSchema.parse({ kind: 'deliver', environmentId: b.id, assignment,
    message: { id: 'op', sender: 'lead', target: 'worker', text: 'work' } })
  await expect(second.runtime.receive(a.id, input)).rejects.toThrow('stored member lacks its agent preset')
  expect(b.ctx.agents.get(sessionId)).toBeUndefined()
})

it('uses stored pairing secrets and applies rotation and removal to the next request', async () => {
  const a = await host()
  const b = await host()
  const key = pair(a, b)
  const secret = process.env[key]!
  Reflect.deleteProperty(process.env, key)
  await a.ctx.credentials.set(credentialRef(key), secret)
  await mount(a)
  const request = (value: string) => fetch(`${a.url}${PEER_PATH}`, { headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' } })
  expect((await request(secret)).status).toBe(415)
  const rotated = randomUUID()
  await a.ctx.credentials.set(credentialRef(key), rotated)
  expect((await request(secret)).status).toBe(401)
  expect((await request(rotated)).status).toBe(415)
  await a.ctx.credentials.unset(credentialRef(key))
  expect((await request(rotated)).status).toBe(401)
})

describe('paired workspace management', () => {
  async function fixtures(options: { workspacePageSize?: number; maxBytes?: number; granted?: boolean } = {}) {
    const a = await host()
    const b = await host()
    pair(a, b)
    b.config.peers[0]!.workspaceManagement = options.granted ?? true
    await mount(a)
    const mounted = await mount(b, { ...b.config, ...options })
    const transport = new PeerTransport(a.id, resolveConfig(a.config), a.ctx.credentials)
    const call = async (request: WorkspaceRequest) => workspaceResultSchema.parse(JSON.parse(await transport.call(b.id, { kind: 'workspace', environmentId: b.id, request }, signal)))
    return { a, b, call, mounted }
  }

  it('creates and registers a directory on the destination without touching the caller filesystem', async () => {
    const { a, b, call } = await fixtures()
    expect(await call({ action: 'catalog' })).toMatchObject({ kind: 'catalog', roots: [{ alias: 'project', path: b.cwd }], workspaces: [{ environmentId: b.id }] })
    expect(await call({ action: 'mkdir', alias: 'project', relativePath: '', name: 'remote-project' })).toMatchObject({ kind: 'directory', path: join(b.cwd, 'remote-project'), relativePath: 'remote-project' })
    const request = { action: 'register', alias: 'project', relativePath: 'remote-project' } as const
    const values = await Promise.all([call(request), call(request)])
    expect(values[0]).toEqual(values[1])
    expect(values[0]).toMatchObject({ kind: 'registered', workspace: { environmentId: b.id, path: join(b.cwd, 'remote-project') } })
    expect(b.ctx.workspaceRegistry.list()).toHaveLength(2)
    expect(a.ctx.workspaceRegistry.list()).toHaveLength(1)
    await expect(readFile(join(a.cwd, 'remote-project'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await call({ action: 'mkdir', alias: 'project', relativePath: '', name: 'remote-project' })).toMatchObject({ kind: 'directory' })
    expect(await call({ action: 'browse', alias: 'project', relativePath: '' })).toMatchObject({ entries: [{ name: 'remote-project', relativePath: 'remote-project' }] })
  })

  it('requires explicit workspace management permission and applies grant removal immediately', async () => {
    const { b, call, mounted } = await fixtures({ granted: false })
    await expect(call({ action: 'catalog' })).rejects.toThrow('HTTP 403')
    await mounted.dispose()
    b.config.peers[0]!.workspaceManagement = true
    const allowed = await mount(b)
    expect(await call({ action: 'catalog' })).toMatchObject({ kind: 'catalog' })
    await allowed.dispose()
    b.config.peers[0]!.workspaces = []
    await mount(b)
    expect(await call({ action: 'catalog' })).toMatchObject({ roots: [], workspaces: [] })
    await expect(call({ action: 'browse', alias: 'project', relativePath: '' })).rejects.toThrow('HTTP 403')
  })

  it('rejects traversal, absolute paths, and directory symlinks outside the grant', async () => {
    const { a, b, call } = await fixtures()
    for (const relativePath of ['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a/../b']) {
      const result = await fetch(`${b.url}${PEER_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${process.env[a.config.peers[0]!.tokenEnv]}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'workspace', environmentId: b.id, request: { action: 'browse', alias: 'project', relativePath } }) })
      expect(result.status).toBe(400)
      await result.body?.cancel()
    }
    const link = join(b.cwd, 'escape')
    await symlink(a.cwd, link, 'junction')
    try {
      await expect(call({ action: 'register', alias: 'project', relativePath: 'escape' })).rejects.toThrow('HTTP 403')
      await expect(call({ action: 'mkdir', alias: 'project', relativePath: 'escape', name: 'bad' })).rejects.toThrow('HTTP 403')
    } finally { await unlink(link) }
    await expect(call({ action: 'browse', alias: 'missing', relativePath: '' })).rejects.toThrow('HTTP 403')
    await writeFile(join(b.cwd, 'file'), 'content')
    await expect(call({ action: 'browse', alias: 'project', relativePath: 'file' })).rejects.toThrow('HTTP 403')
    await expect(call({ action: 'mkdir', alias: 'project', relativePath: '', name: 'file' })).rejects.toThrow('HTTP 403')
  })

  it('reports bounded directory and registry views with explicit truncation', async () => {
    const { b, call } = await fixtures({ workspacePageSize: 1 })
    await mkdir(join(b.cwd, 'one'))
    await mkdir(join(b.cwd, 'two'))
    await b.ctx.workspaceRegistry.create(join(b.cwd, 'one'))
    await b.ctx.workspaceRegistry.create(join(b.cwd, 'two'))
    const directory = await call({ action: 'browse', alias: 'project', relativePath: '' })
    expect(directory).toMatchObject({ kind: 'directory', truncated: true })
    if (directory.kind !== 'directory') throw new Error('wrong response')
    expect(directory.entries).toHaveLength(1)
    const catalog = await call({ action: 'catalog' })
    expect(catalog).toMatchObject({ kind: 'catalog', truncated: true })
    if (catalog.kind !== 'catalog') throw new Error('wrong response')
    expect(catalog.workspaces).toHaveLength(1)
  })

  it('bounds complete encoded workspace responses', async () => {
    const { call } = await fixtures({ maxBytes: 200 })
    await expect(call({ action: 'catalog' })).rejects.toThrow('HTTP 403')
  })

  it('omits missing and escaped registered directories and sorts directory names without listing files', async () => {
    const { b, call } = await fixtures()
    await mkdir(join(b.cwd, 'zebra'))
    await mkdir(join(b.cwd, 'alpha'))
    await writeFile(join(b.cwd, 'file.txt'), 'not a directory')
    const missing = join(b.cwd, 'missing')
    await mkdir(missing)
    await b.ctx.workspaceRegistry.create(missing)
    await rm(missing, { recursive: true })
    const outside = await temporary()
    await b.ctx.workspaceRegistry.create(outside)
    expect(await call({ action: 'catalog' })).toMatchObject({ workspaces: [{ path: b.cwd }] })
    expect(await call({ action: 'browse', alias: 'project', relativePath: '' })).toMatchObject({ entries: [{ name: 'alpha' }, { name: 'zebra' }] })
  })

  it('refuses workspace requests to an older peer before sending a mutation', async () => {
    const a = await host()
    const b = await host()
    pair(a, b)
    b.ctx.effect(() => b.ctx.webServer.register({ kind: 'exact', path: DESCRIPTOR_PATH, handler(_request, response) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ environmentId: b.id, label: 'older', platform: 'linux', protocol: 1, capabilities: { distributedTeams: true } }))
    } }))
    const transport = new PeerTransport(a.id, resolveConfig(a.config), a.ctx.credentials)
    await expect(transport.call(b.id, { kind: 'workspace', environmentId: b.id, request: { action: 'catalog' } }, signal)).rejects.toThrow('does not support')
    await expect(transport.describe(a.id, signal)).rejects.toThrow('not configured')
    expect(b.ctx.workspaceRegistry.list()).toHaveLength(0)
  })

  it('reports filesystem failures instead of showing an empty catalog or successful creation', async () => {
    const { b, call } = await fixtures()
    const resolvePath = vi.spyOn(filesystem, 'realpath').mockResolvedValueOnce(b.cwd).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    try { await expect(call({ action: 'catalog' })).rejects.toThrow('HTTP 403') } finally { resolvePath.mockRestore() }
    const create = vi.spyOn(filesystem, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    try { await expect(call({ action: 'mkdir', alias: 'project', relativePath: '', name: 'denied' })).rejects.toThrow('HTTP 403') } finally { create.mockRestore() }
    await expect(filesystem.stat(join(b.cwd, 'denied'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
