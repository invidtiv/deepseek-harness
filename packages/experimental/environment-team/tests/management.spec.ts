/** Profile persistence and secret isolation for operator deployment edits. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config } from '../src/config.ts'
import EnvironmentTeamSettings from '../src/management.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PeerTransport } from '../src/transport.ts'
import { descriptorSchema } from '../src/protocol.ts'
import type { EnvironmentConfiguration } from '../src/settings-types.ts'
import { sessionRequestSchema, sessionResultSchema } from '../src/session-protocol.ts'
import { EnvironmentSessions } from '../src/session-service.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { EnvironmentSessionFrame, EnvironmentSessionFollowRequest } from '../src/session-types.ts'

it('follows only the addressed environment and releases a suspended stream on disposal', async () => {
  const { start } = await fixture()
  const { controller, ctx } = await start()
  const current = await controller.read()
  const target = brandString<EnvironmentConfiguration['environmentId']>(randomUUID())
  const request: EnvironmentSessionFollowRequest = { workspaceId: brandString<EnvironmentSessionFollowRequest['workspaceId']>('remote-workspace'), sessionId: brandString<EnvironmentSessionFollowRequest['sessionId']>('remote-session') }
  const snapshot: EnvironmentSessionFrame = { kind: 'snapshot', environmentId: target, ...request, cursor: -1, running: false, messages: [], truncated: false }
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const remote = vi.spyOn(PeerTransport.prototype, 'follow').mockImplementation(async function* (_target, _request, signal) {
    try {
      yield snapshot
      if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } finally { finish() }
  })
  const local = vi.spyOn(EnvironmentSessions.prototype, 'follow')
  const iterator = controller.sessionFollow(target, request, new AbortController().signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: snapshot })
  expect(remote).toHaveBeenCalledWith(target, request, expect.any(AbortSignal))
  expect(local).not.toHaveBeenCalled()
  // A browser can stop requesting frames while the plugin is unloading.
  await ctx.fiber.dispose()
  await finished
  expect((await iterator.next()).done).toBe(true)
  expect(current.environmentId).not.toBe(target)
})

it('follows the local owner without contacting a peer and skips already cancelled subscriptions', async () => {
  const { start } = await fixture()
  const { controller } = await start()
  const current = await controller.read()
  const request: EnvironmentSessionFollowRequest = { workspaceId: brandString<EnvironmentSessionFollowRequest['workspaceId']>('local-workspace'), sessionId: brandString<EnvironmentSessionFollowRequest['sessionId']>('local-session') }
  const snapshot: EnvironmentSessionFrame = { kind: 'snapshot', environmentId: current.environmentId, ...request, cursor: -1, running: false, messages: [], truncated: false }
  const local = vi.spyOn(EnvironmentSessions.prototype, 'follow').mockImplementation(async function* () { yield snapshot })
  const remote = vi.spyOn(PeerTransport.prototype, 'follow')
  const abort = new AbortController()
  abort.abort(new Error('panel closed'))
  expect((await controller.sessionFollow(current.environmentId, request, abort.signal)[Symbol.asyncIterator]().next()).done).toBe(true)
  expect(local).not.toHaveBeenCalled()
  const iterator = controller.sessionFollow(current.environmentId, request, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual(snapshot)
  await iterator.return?.()
  expect(remote).not.toHaveBeenCalled()
})

it('closes an operator follow when its runtime configuration is replaced', async () => {
  const { start } = await fixture()
  const { controller } = await start()
  const current = await controller.read()
  const request: EnvironmentSessionFollowRequest = { workspaceId: brandString<EnvironmentSessionFollowRequest['workspaceId']>('workspace'), sessionId: brandString<EnvironmentSessionFollowRequest['sessionId']>('session') }
  const snapshot: EnvironmentSessionFrame = { kind: 'snapshot', environmentId: current.environmentId, ...request, cursor: -1, running: false, messages: [], truncated: false }
  let stopped = false
  vi.spyOn(EnvironmentSessions.prototype, 'follow').mockImplementation(async function* (_peer, _request, signal) {
    try {
      yield snapshot
      if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } finally { stopped = true }
  })
  const iterator = controller.sessionFollow(current.environmentId, request, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual(snapshot)
  await controller.save({ ...current, config: { ...current.config, label: 'updated runtime' } })
  expect(stopped).toBe(true)
  expect((await iterator.next()).done).toBe(true)
})

it('preserves a terminal peer rejection when the producer finishes', async () => {
  const { start } = await fixture()
  const { controller } = await start()
  const target = brandString<EnvironmentConfiguration['environmentId']>(randomUUID())
  const request: EnvironmentSessionFollowRequest = { workspaceId: brandString<EnvironmentSessionFollowRequest['workspaceId']>('workspace'), sessionId: brandString<EnvironmentSessionFollowRequest['sessionId']>('session') }
  vi.spyOn(PeerTransport.prototype, 'follow').mockImplementation(() => ({
    [Symbol.asyncIterator]() { return { next: () => Promise.reject(new RemoteError('environment/session-denied', 'Session access was revoked', {})) } },
  }))
  await expect(controller.sessionFollow(target, request, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-denied' })
})

const contexts: Awaited<ReturnType<typeof boot>>[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

it('routes session requests to the selected destination and rejects mismatched or malformed responses', async () => {
  const { start } = await fixture()
  const { controller } = await start()
  const current = await controller.read()
  const target = brandString<EnvironmentConfiguration['environmentId']>(randomUUID())
  const request = sessionRequestSchema.parse({ action: 'create', workspaceId: 'workspace-remote', sessionId: 'session-remote' })
  const created = { kind: 'created', environmentId: target, workspaceId: request.workspaceId, sessionId: 'session-remote' }
  const call = vi.spyOn(PeerTransport.prototype, 'call').mockResolvedValue(JSON.stringify(created))
  const local = vi.spyOn(EnvironmentSessions.prototype, 'run')
  const signal = new AbortController().signal
  expect(await controller.session(target, request, signal)).toEqual(created)
  expect(call).toHaveBeenCalledWith(target, { kind: 'session', environmentId: target, request }, expect.any(AbortSignal))
  expect(local).not.toHaveBeenCalled()
  call.mockResolvedValueOnce(JSON.stringify({ ...created, kind: 'accepted' }))
  await expect(controller.session(target, request, signal)).rejects.toThrow('action mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ ...created, environmentId: current.environmentId }))
  await expect(controller.session(target, request, signal)).rejects.toThrow('destination mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ ...created, workspaceId: 'workspace-other' }))
  await expect(controller.session(target, request, signal)).rejects.toThrow('destination mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ ...created, sessionId: 'session-other' }))
  await expect(controller.session(target, request, signal)).rejects.toThrow('identity mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ ...created, unexpected: true }))
  await expect(controller.session(target, request, signal)).rejects.toThrow()
  call.mockRejectedValueOnce(new Error('destination offline'))
  await expect(controller.session(target, request, signal)).rejects.toThrow('destination offline')
  expect(local).not.toHaveBeenCalled()
  local.mockResolvedValueOnce(sessionResultSchema.parse({ ...created, environmentId: current.environmentId }))
  expect(await controller.session(current.environmentId, request, signal)).toMatchObject({ environmentId: current.environmentId })
})

it('cancels session reads with their operator request and waits for them during disposal', async () => {
  const { start } = await fixture()
  const { controller, ctx } = await start()
  const target = brandString<EnvironmentConfiguration['environmentId']>(randomUUID())
  const request = sessionRequestSchema.parse({ action: 'list', workspaceId: 'workspace-remote' })
  const call = vi.spyOn(PeerTransport.prototype, 'call').mockImplementation((_target, _request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('read cancelled')) }, { once: true })
  }))
  const abort = new AbortController()
  abort.abort()
  await expect(controller.session(target, request, abort.signal)).rejects.toThrow()
  expect(call).not.toHaveBeenCalled()
  const pending = controller.session(target, request, new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow('read cancelled')
  await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
  await ctx.fiber.dispose()
  await rejected
  await expect(controller.session(target, request, new AbortController().signal)).rejects.toThrow('closed')
})

it('retains offline and unsupported peer identities without routing their workspace operations locally', async () => {
  const { start } = await fixture()
  const { controller, ctx } = await start()
  const original = await controller.read()
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const peers = ids.map((environmentId, index) => ({ environmentId, url: `https://worker${index}.example.ts.net`, tokenEnv: `DSH_PAIR_${index}`, workspaces: [] }))
  for (const peer of peers) await ctx.credentials.set(credentialRef(peer.tokenEnv), randomUUID())
  await controller.save({ ...original, config: { ...original.config, peers } })
  vi.spyOn(PeerTransport.prototype, 'describe').mockImplementation(async (id) => {
    if (id === ids[2]) throw new Error('offline')
    return descriptorSchema.parse({ environmentId: id, label: 'worker', platform: process.platform, protocol: 1, capabilities: { distributedTeams: true, ...(id === ids[0] ? { workspaceBrowser: true } : {}) } })
  })
  expect((await controller.environments()).map(item => [item.environmentId, item.status])).toEqual([
    [original.environmentId, 'online'], [ids[0], 'online'], [ids[1], 'unsupported'], [ids[2], 'unavailable'],
  ])
  const target = brandString<EnvironmentConfiguration['environmentId']>(ids[0]!)
  const call = vi.spyOn(PeerTransport.prototype, 'call').mockResolvedValue(JSON.stringify({ kind: 'catalog', roots: [], workspaces: [], truncated: false }))
  expect(await controller.workspace(target, { action: 'catalog' })).toMatchObject({ kind: 'catalog' })
  call.mockResolvedValueOnce(JSON.stringify({ kind: 'directory', alias: 'project', relativePath: '', path: '/remote', entries: [], truncated: false }))
  await expect(controller.workspace(target, { action: 'catalog' })).rejects.toThrow('action mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ kind: 'directory', alias: 'project', relativePath: '', path: '/remote', entries: [], truncated: false }))
  expect(await controller.workspace(target, { action: 'browse', alias: 'project', relativePath: '' })).toMatchObject({ path: '/remote' })
  await expect(controller.workspace(original.environmentId, { action: 'browse', alias: 'missing', relativePath: '' })).rejects.toThrow('workspace alias is not granted')
  const workspace = { environmentId: original.environmentId, workspaceId: 'other', alias: 'project', relativePath: '', path: '/remote', title: 'remote' }
  call.mockResolvedValueOnce(JSON.stringify({ kind: 'registered', workspace }))
  await expect(controller.workspace(target, { action: 'register', alias: 'project', relativePath: '' })).rejects.toThrow('identity mismatch')
  call.mockResolvedValueOnce(JSON.stringify({ kind: 'catalog', roots: [], workspaces: [workspace], truncated: false }))
  await expect(controller.workspace(target, { action: 'catalog' })).rejects.toThrow('identity mismatch')
  call.mockRejectedValueOnce(new Error('offline'))
  await expect(controller.workspace(target, { action: 'catalog' })).rejects.toThrow('offline')
  await ctx.fiber.dispose()
  await expect(controller.environments()).rejects.toThrow('closed')
})

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-team-settings-')))
  roots.push(home)
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const config = { stateDirectory: join(home, 'identity'), label: 'host', provider: 'mock', model: 'mock', agentPreset: 'test', sandboxMode: 'read-only', approvalPolicy: 'ask', workspaces: {}, peers: [] }
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'editor', name: 'cordis:editor' },
    { id: 'credentials', name: 'cordis:credentials', config: { path: join(home, 'credentials.yml'), watch: false } },
    { id: 'environment-team', name: 'cordis:environment', config },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, { editor: ConfigEditor, credentials: Credentials, environment: { name: 'environment-team', Config, apply() {} } })
    })
    contexts.push(ctx)
    return { ctx, controller: new EnvironmentTeamSettings(ctx) }
  }
  return { home, profile, start }
}

it('saves peer routes and local checkouts in the profile, preserving identity across restart', async () => {
  const { home, profile, start } = await fixture()
  const first = await start()
  const before = await first.controller.read()
  const secret = randomUUID() + randomUUID()
  await first.ctx.credentials.set(credentialRef('DSH_TEST_PAIR'), secret)
  const changed = await first.controller.save({ ...before, config: { ...before.config, label: 'coordinator', workspaces: { project: home }, peers: [{ environmentId: randomUUID(), url: 'https://worker.example.ts.net', tokenEnv: 'DSH_TEST_PAIR', workspaces: ['project'] }] } })
  expect(changed.config.label).toBe('coordinator')
  expect(changed.revision).not.toBe(before.revision)
  expect(changed.environmentId).toBe(before.environmentId)
  const saved = await readFile(profile.patchPath, 'utf8')
  expect(saved).toContain('worker.example.ts.net')
  expect(saved).not.toContain(secret)
  await expect(first.controller.save(before)).rejects.toThrow('Configuration changed')
  await first.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(first.ctx), 1)
  const second = await start()
  expect(await second.controller.read()).toEqual(changed)
})

it('rejects unavailable paths, identity changes, and incomplete or shared pairing secrets before saving', async () => {
  const { home, start } = await fixture()
  const { controller, ctx } = await start()
  const before = await controller.read()
  await expect(controller.save({ ...before, config: { ...before.config, stateDirectory: home } })).rejects.toThrow('cannot be moved')
  await expect(controller.save({ ...before, config: { ...before.config, workspaces: { project: join(home, 'package.json') } } })).rejects.toThrow('existing local directory')
  const peer = { environmentId: randomUUID(), url: 'https://worker.example.ts.net', tokenEnv: 'DSH_TEST_PAIR', workspaces: [] }
  await expect(controller.save({ ...before, config: { ...before.config, peers: [peer] } })).rejects.toThrow('pairing secret')
  await ctx.credentials.set(credentialRef('DSH_TEST_PAIR'), randomUUID())
  await expect(controller.save({ ...before, config: { ...before.config, peers: [peer, { ...peer, environmentId: randomUUID() }] } })).rejects.toThrow('different pairing secret')
  await expect(controller.save({ ...before, config: { ...before.config, peers: [{ ...peer, environmentId: before.environmentId }] } })).rejects.toThrow('itself')
  expect(await controller.read()).toEqual(before)
})

it('refuses editing while the runtime is absent or disabled', async () => {
  const { start } = await fixture()
  const { ctx, controller } = await start()
  const entry = ctx.configEditor.entries().find(item => item.options.id === 'environment-team')!
  const spy = vi.spyOn(ctx.configEditor, 'entries')
  const fiber = entry.fiber!
  try {
    spy.mockReturnValue([])
    await expect(controller.read()).rejects.toThrow('not enabled')
    delete entry.fiber
    spy.mockReturnValue([entry])
    await expect(controller.read()).rejects.toThrow('not enabled')
  } finally { entry.fiber = fiber; spy.mockRestore() }
})

it('routes dashboard requests only to the selected coordinator and rejects mismatched identities', async () => {
  const { start } = await fixture()
  const { controller } = await start()
  const current = await controller.read()
  const target = brandString<EnvironmentConfiguration['environmentId']>(randomUUID())
  const signal = new AbortController().signal
  const descriptor = descriptorSchema.parse({ environmentId: target, label: 'peer', platform: 'linux', protocol: 1,
    capabilities: { distributedTeams: true, teamDashboard: true } })
  const describe = vi.spyOn(PeerTransport.prototype, 'describe').mockResolvedValue(descriptor)
  const result = { kind: 'catalog', environmentId: target, teams: [] }
  const call = vi.spyOn(PeerTransport.prototype, 'call').mockResolvedValue(JSON.stringify(result))
  expect(await controller.teamDashboard(target, { action: 'catalog' }, signal)).toEqual(result)
  expect(call).toHaveBeenCalledWith(target, { kind: 'team-dashboard', environmentId: target,
    request: { action: 'catalog' } }, expect.any(AbortSignal))
  call.mockResolvedValueOnce(JSON.stringify({ ...result, environmentId: current.environmentId }))
  await expect(controller.teamDashboard(target, { action: 'catalog' }, signal)).rejects.toThrow('mismatch')
  describe.mockResolvedValueOnce({ ...descriptor, capabilities: { distributedTeams: true } })
  await expect(controller.teamDashboard(target, { action: 'catalog' }, signal)).rejects.toThrow('unsupported')
  await expect(controller.teamDashboard(current.environmentId, { action: 'catalog' }, signal)).rejects.toThrow('unavailable')
})

it('rejects a history page containing messages outside its exclusive requested range', async () => {
  const { start } = await fixture()
  const { controller } = await start()
  const environmentId = brandString<EnvironmentConfiguration['environmentId']>(randomUUID())
  const request = sessionRequestSchema.parse({ action: 'read', workspaceId: 'workspace', sessionId: 'session', beforeSeq: 10 })
  const response = { environmentId, workspaceId: request.workspaceId, kind: 'snapshot', sessionId: 'session', cursor: 20, running: false, messages: [{ seq: 10, role: 'user', text: 'outside requested history' }], truncated: false }
  const call = vi.spyOn(PeerTransport.prototype, 'call').mockResolvedValue(JSON.stringify(response))
  await expect(controller.session(environmentId, request, new AbortController().signal)).rejects.toThrow('exceeds requested range')
  call.mockResolvedValue(JSON.stringify({ ...response, messages: [{ seq: 9, role: 'user', text: 'earlier message' }] }))
  await expect(controller.session(environmentId, request, new AbortController().signal)).resolves.toMatchObject({ messages: [{ seq: 9 }] })
})
