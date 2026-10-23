/** Real destination persistence and Agent composition with the Session Controller's text-only test carriers. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import Workspace from '@deepseek-ai/dsh-workspace'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { loadIdentity } from '../src/identity.ts'
import { resolveConfig } from '../src/config.ts'

/**
 * Boot an isolated Loader destination; callers must register close immediately.
 * @param prepare - optional owning services installed before the Session Controller.
 * @returns destination services and a quiescent cleanup operation.
 */
export async function sessionHost(prepare?: (ctx: Context, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-peer-')))
  const ctx = new Context()
  const close = async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
  try {
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, llm: LlmRuntime, sessions: SessionStore, projections: Projections,
      prompt: SystemPrompt, tools: Tools, executor: NativeExecutor, agents: AgentRegistry, loop: AgentLoop,
      persistence: Persistence, storage: Storage, json: JsonStorage, domain: StorageDomain,
      presets: AgentPresets, preset: AgentPreset, workspace: Workspace, web: WebServer,
    })
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([
      ...['llm', 'sessions', 'projections', 'prompt', 'tools', 'executor', 'agents', 'storage'].map(name => ({ name: `cordis:${name}` })),
      { name: 'cordis:persistence', config: { root: join(root, 'sessions') } },
      { name: 'cordis:json', config: { root: join(root, 'storage') } },
      { name: 'cordis:domain', config: { backend: 'json' } },
      { name: 'cordis:loop', config: { agents: [] } },
      { name: 'cordis:presets', config: { default: 'test' } },
      { name: 'cordis:preset', config: { id: 'test', plugins: [] } },
      { name: 'cordis:workspace' },
      { name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const adapter = new MockAdapter(Array.from({ length: 30 }, () => textResponse('destination reply')))
    ctx.llm.registerAdapter(['mock'], adapter)
    await prepare?.(ctx, root)
    await ctx.plugin({
      inject: ['sessions', 'agents', 'llm', 'workspaceRegistry', 'sessionProjections', 'sessionPersistence', ...(prepare ? ['typert', 'attachments', 'fileUploads'] : [])],
      async apply(scope) { await createSessionTestController(scope, { cwd, defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }) }) },
    })
    const controller = ctx.sessionController
    const id = await loadIdentity(join(root, 'identity'))
    const workspace = await ctx.workspaceRegistry.create(cwd)
    const config = resolveConfig({ stateDirectory: join(root, 'identity'), label: 'destination', provider: 'mock', model: 'mock', agentPreset: 'test', sandboxMode: 'workspace-write', approvalPolicy: 'ask', workspaces: { project: cwd } })
    return { ctx, root, cwd, id, config, adapter, controller, workspace, close, url: `http://127.0.0.1:${ctx.webServer.port}` }
  } catch (error) { await close(); throw error }
}
