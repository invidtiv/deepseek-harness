import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { CommandAdapter } from '../src/commands.ts'
import { SessionManager } from '../src/sessions.ts'
import { telegramTopicsDomain, TopicRegistry, topicKeyOf } from '../src/topics.ts'
import type { TopicRecord } from '../src/topics.ts'
import { WorkspaceGuard } from '../src/workspaces.ts'
import {
  GENERAL_TOPIC,
  makeTelegramHarness,
  textResponse,
  textUpdate,
  type TelegramHarness,
} from './harness.ts'

const KEY = topicKeyOf(GENERAL_TOPIC.chatId, null)

function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 8000, interval: 25 })
}

/** The live mapping registry of a mounted plugin, for external tampering. */
function externalRegistry(harness: TelegramHarness): TopicRegistry {
  const domain = harness.ctx.storageDomain.get('telegram_topics')
  if (domain === undefined) throw new Error('the plugin has no open mapping domain')
  return new TopicRegistry(domain as unknown as Domain<typeof telegramTopicsDomain>)
}

function run(harness: TelegramHarness, agent: Agent, line: string): Promise<CommandResult | undefined> {
  return harness.ctx.commands.execute(agent, line, [], new AbortController().signal)
    .then(execution => execution?.result)
}

describe('CommandAdapter without a session', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function adapter(): Promise<CommandAdapter> {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const domain = await harness.ctx.storageDomain.open(telegramTopicsDomain)
    const registry = new TopicRegistry(domain)
    const guard = await WorkspaceGuard.fromConfig(harness.roots)
    const sessions = new SessionManager(
      harness.ctx.agents,
      harness.ctx.sessionPersistence,
      registry,
      () => ({}),
      harness.ctx.logger,
    )
    return new CommandAdapter(harness.ctx, registry, sessions, () => Promise.resolve(guard), harness.ctx.logger)
  }

  it('answers /help and /folder directly and declines anything else', async () => {
    const direct = await adapter()
    expect(await direct.handleDirect('/status', KEY)).toBeUndefined()
    expect(await direct.handleDirect('/help', KEY)).toContain('/reset — archive this session')
    expect(await direct.handleDirect('/folder', KEY)).toContain('Current workspace: (none)')
    const root = (harness as TelegramHarness).roots[0] as string
    expect(await direct.handleDirect(`/folder ${root}`, KEY)).toBe(
      `Workspace set to '${root}'. Send a message to start.`,
    )
    // The selection is stored on the row the next message creates a session in.
    expect(await direct.handleDirect('/folder', KEY)).toContain(`Current workspace: ${root}`)
  })

  it('keeps a selected workspace on a row that already exists', async () => {
    const direct = await adapter()
    const roots = (harness as TelegramHarness).roots
    const nested = join(roots[0] as string, 'nested')
    await mkdir(nested)
    expect(await direct.handleDirect(`/folder ${roots[0] as string}`, KEY)).toContain('Workspace set to')
    expect(await direct.handleDirect(`/folder ${nested}`, KEY)).toContain(`Workspace set to '${nested}'`)
  })

  it('presents a refused selection verbatim', async () => {
    const direct = await adapter()
    const outside = await mkdtemp(join(tmpdir(), 'telegram-outside-'))
    expect(await direct.handleDirect(`/folder ${outside}`, KEY))
      .toContain('outside the configured workspace roots')
  })
})

describe('CommandAdapter over a live topic', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** Mount the plugin and admit one topic session. */
  async function liveAgent(): Promise<Agent> {
    harness = await makeTelegramHarness({ script: [textResponse('ready')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    return harness.ctx.agents.list()[0] as Agent
  }

  it('answers /help and /folder through the command runtime', async () => {
    const agent = await liveAgent()
    const live = harness as TelegramHarness
    const help = await run(live, agent, '/help')
    expect(help?.kind).toBe('success')
    expect(help?.text).toContain('/cancel')
    const listing = await run(live, agent, '/folder')
    expect(listing?.text).toContain(`Current workspace: ${live.roots[0] as string}`)
    const nested = join(live.roots[0] as string, 'nested')
    await mkdir(nested)
    const selected = await run(live, agent, `/folder ${nested}`)
    expect(selected?.text).toBe(
      `Workspace will change to '${nested}' with /reset (the current session keeps its folder).`,
    )
    expect(externalRegistry(live).get(KEY)?.pendingWorkspace).toBe(nested)
    // The pending selection is what /status now reports.
    expect((await run(live, agent, '/status'))?.text).toContain(`Workspace: ${nested}`)
  })

  it('reports an idle session with no workspace or session recorded', async () => {
    const agent = await liveAgent()
    const live = harness as TelegramHarness
    const registry = externalRegistry(live)
    const row = registry.get(KEY) as TopicRecord
    await registry.put(KEY, { ...row, workspace: null, pendingWorkspace: null })
    const status = await run(live, agent, '/status')
    expect(status?.text).toContain('Workspace: (none)')
    expect(status?.text).toContain('State: idle')
    await registry.put(KEY, { ...row, sessionId: null, workspace: null, pendingWorkspace: null })
    expect((await run(live, agent, '/status'))?.text).toContain('Session: (none yet)')
  })

  it('refuses /reset for a topic whose mapping row is gone', async () => {
    const agent = await liveAgent()
    const live = harness as TelegramHarness
    await externalRegistry(live).delete(KEY)
    expect(await run(live, agent, '/reset')).toEqual({ kind: 'error', text: 'This topic has no mapping row.' })
  })

  it('reports a /reset that cannot retire the current session', async () => {
    const agent = await liveAgent()
    const live = harness as TelegramHarness
    const registry = externalRegistry(live)
    const row = registry.get(KEY) as TopicRecord
    await registry.put(KEY, { ...row, workspace: null, pendingWorkspace: null })
    const result = await run(live, agent, '/reset')
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('Reset failed:')
  })

  it('archives the retired session through the workspace registry', async () => {
    const agent = await liveAgent()
    const live = harness as TelegramHarness
    await live.ctx.plugin(WorkspaceRegistry)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await live.ctx.sessions.flush(agent.session)
    const retired = agent.session.id
    const result = await run(live, agent, '/reset')
    expect(result?.text).toContain('Reset complete')
    expect(live.ctx.workspaceRegistry.archivedSessionIds).toContain(retired)
  }, 20000)

  it('refuses every topic command for an agent the plugin does not own', async () => {
    const agent = await liveAgent()
    const live = harness as TelegramHarness
    const sessionId = agent.session.id
    await waitFor(() => {
      expect(live.api.texts()).toContain('ready')
    })
    const { storageRoot, persistenceRoot, roots } = live
    // Restart the plugin, then resume the same mapped session outside it: the
    // mapping still names the session, but no live topic owns it.
    await live.dispose()
    harness = await makeTelegramHarness({ storageRoot, persistenceRoot, workspaceRoots: roots })
    const revived = harness
    await revived.api.waitForPoll()
    const handle = await revived.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(await run(revived, handle.agent, '/status'))
      .toEqual({ kind: 'error', text: 'This session is not a Telegram topic session.' })
    expect(await run(revived, handle.agent, '/reset'))
      .toEqual({ kind: 'error', text: 'This session is not a live Telegram topic session.' })
    expect(await run(revived, handle.agent, '/cancel'))
      .toEqual({ kind: 'error', text: 'This session is not a live Telegram topic session.' })
    expect((await run(revived, handle.agent, '/folder'))?.text).toContain('Allowed roots:')
    await handle.dispose()
  }, 30000)
})
