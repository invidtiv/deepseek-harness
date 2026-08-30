/**
 * Defensive paths the plugin's own invariants keep Telegram traffic away from:
 * a mapping row that disappears between two lookups, a configuration emptied
 * after construction, a teardown that precedes the poll loop, a live-topic
 * lookup after admission removed the topic. Each test drives the exported
 * class directly and states the state it fabricates; the behavior under test
 * is that the plugin answers or unwinds instead of throwing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { CommandAdapter } from '../src/commands.ts'
import type { Config } from '../src/config.ts'
import { TelegramRuntime } from '../src/index.ts'
import { SessionManager } from '../src/sessions.ts'
import type { LiveTopic } from '../src/sessions.ts'
import { telegramTopicsDomain, TopicRegistry, topicKeyOf } from '../src/topics.ts'
import type { TopicRecord } from '../src/topics.ts'
import type { TopicKey } from '../src/types.ts'
import { WorkspaceGuard } from '../src/workspaces.ts'
import {
  ALLOWED_USER,
  GENERAL_TOPIC,
  makeTelegramHarness,
  textResponse,
  textUpdate,
  type TelegramHarness,
} from './harness.ts'

const KEY = topicKeyOf(GENERAL_TOPIC.chatId, null)

/** The mounted plugin's configuration, over the harness transport. */
function runtimeConfig(harness: TelegramHarness): Config {
  return {
    allowedChatIds: [GENERAL_TOPIC.chatId],
    allowedUserIds: [ALLOWED_USER],
    workspaceRoots: [...harness.roots],
    agentOptions: { provider: 'mock', model: 'mock' },
    transport: harness.api,
  }
}

function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 8000, interval: 25 })
}

/** The private collaborators these teardown paths reach. */
interface RuntimeInternals {
  running: boolean
  disposers: Array<() => void>
  interactions: { dispose: () => void }
  sessions: { disposeAll: () => Promise<void> }
  renderAgentOptions: () => import('../src/sessions.ts').TelegramAgentOptions
  renderEditInterval: () => number
  renderApprovalTimeout: () => number
  onSettingsCommitted: () => void
}

describe('TelegramRuntime teardown and configuration re-reads', () => {
  let harness: TelegramHarness | undefined
  let runtime: TelegramRuntime | undefined

  afterEach(async () => {
    await runtime?.stop()
    await harness?.dispose()
    harness = undefined
    runtime = undefined
  })

  it('reads the configured roots again when polling starts', async () => {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const config = runtimeConfig(harness)
    runtime = new TelegramRuntime(harness.ctx, config)
    // The constructor accepted the roots; a config emptied afterwards leaves
    // the guard with none, so no topic can be admitted.
    delete config.workspaceRoots
    await runtime.start()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('No workspace selected for this topic')
    })
  })

  it('refuses admission when the single configured root is unusable', async () => {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const config = runtimeConfig(harness)
    runtime = new TelegramRuntime(harness.ctx, config)
    await runtime.start()
    // A guard whose sole canonical root vanished leaves the implicit-default
    // path with nothing to select, so no topic can be admitted.
    const fabricated = new WorkspaceGuard([undefined as unknown as string])
    Reflect.set(runtime, 'guardState', {
      roots: config.workspaceRoots as readonly string[],
      guard: Promise.resolve(fabricated),
    })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('No workspace selected for this topic')
    })
  })

  it('keeps unwinding when a registration disposer throws', async () => {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const started = new TelegramRuntime(harness.ctx, runtimeConfig(harness))
    await started.start()
    const internals = started as unknown as RuntimeInternals
    internals.disposers.push(() => { throw new Error('registration already gone') })
    await expect(started.stop()).resolves.toBeUndefined()
    // A second teardown is a no-op, so the throwing disposer ran only once.
    await expect(started.stop()).resolves.toBeUndefined()
  })

  it('unwinds a teardown that precedes the poll loop', async () => {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const unstarted = new TelegramRuntime(harness.ctx, runtimeConfig(harness))
    const internals = unstarted as unknown as RuntimeInternals
    let interactionsDisposed = false
    let sessionsDisposed = false
    internals.running = true
    internals.interactions = { dispose: () => { interactionsDisposed = true } }
    internals.sessions = { disposeAll: async () => { sessionsDisposed = true } }
    await unstarted.stop()
    expect([interactionsDisposed, sessionsDisposed]).toEqual([true, true])
  })
})

interface Fixture {
  readonly harness: TelegramHarness
  readonly registry: TopicRegistry
  readonly manager: SessionManager
  readonly adapter: CommandAdapter
  readonly workspace: string
}

async function fixture(): Promise<Fixture> {
  const harness = await makeTelegramHarness({ mountPlugin: false, script: [textResponse('seeded')] })
  const domain: Domain<typeof telegramTopicsDomain> = await harness.ctx.storageDomain.open(telegramTopicsDomain)
  const registry = new TopicRegistry(domain)
  const manager = new SessionManager(
    harness.ctx.agents,
    harness.ctx.sessionPersistence,
    registry,
    () => ({ provider: 'mock', model: 'mock' }),
    harness.ctx.logger,
  )
  const guard = await WorkspaceGuard.fromConfig(harness.roots)
  const adapter = new CommandAdapter(harness.ctx, registry, manager, () => Promise.resolve(guard), harness.ctx.logger)
  return { harness, registry, manager, adapter, workspace: harness.roots[0] as string }
}

async function admit(current: Fixture): Promise<LiveTopic> {
  const resolution = await current.manager.resolve(KEY, current.workspace)
  if (!resolution.ok) throw new Error(`unexpected refusal: ${resolution.reply}`)
  return resolution.topic
}

/** Run one registered command against an agent. */
function run(current: Fixture, agent: Agent, line: string): Promise<string | undefined> {
  return current.harness.ctx.commands.execute(agent, line, [], new AbortController().signal)
    .then(execution => execution?.result.text)
}

describe('Topic commands against impossible mapping state', () => {
  let current: Fixture | undefined
  let disposers: Array<() => void> = []

  afterEach(async () => {
    for (const dispose of disposers) dispose()
    disposers = []
    await current?.manager.disposeAll()
    await current?.harness.dispose()
    current = undefined
  })

  it('rejects a live-topic lookup for a topic that has none', async () => {
    current = await fixture()
    const internals = current.manager as unknown as { requireLive: (key: TopicKey) => LiveTopic }
    expect(() => internals.requireLive(KEY)).toThrow(/has no live session after admission/u)
  })

  it('reports a mapping row that disappears between the two lookups', async () => {
    current = await fixture()
    const topic = await admit(current)
    const agent = topic.agent
    await current.manager.disposeAll()
    // The topic is mapped but no longer live, and the row lookup that follows
    // the live-topic lookup answers nothing.
    const real = current.registry.keyOfSession.bind(current.registry)
    let lookups = 0
    vi.spyOn(current.registry, 'keyOfSession').mockImplementation((sessionId: string) => {
      lookups += 1
      return lookups === 1 ? real(sessionId) : undefined
    })
    disposers = current.adapter.register(current.harness.ctx.commands)
    expect(await run(current, agent, '/status')).toBe('This session is not a Telegram topic session.')
    lookups = 0
    expect(await run(current, agent, '/folder')).toBe('This session is not a Telegram topic session.')
  })

  it('reports a successor session that cannot start after the reset', async () => {
    current = await fixture()
    const topic = await admit(current)
    const registry = current.registry
    const spy = vi.spyOn(registry, 'put')
    spy.mockImplementation(async (key: TopicKey, record: TopicRecord) => {
      // A concurrent workspace change lands between the reset's own mapping
      // write and the admission of the successor session.
      spy.mockRestore()
      await registry.put(key, record)
      await registry.put(key, { ...record, workspace: null, pendingWorkspace: null })
    })
    disposers = current.adapter.register(current.harness.ctx.commands)
    expect(await run(current, topic.agent, '/reset'))
      .toContain('Reset completed but the fresh session failed: No workspace selected for this topic.')
  })

  it('presents a selection failure that is not an Error', async () => {
    current = await fixture()
    const brittle = {
      canonicalRoots: [],
      select: () => Promise.reject('not a usable path'),
    } as unknown as WorkspaceGuard
    const adapter = new CommandAdapter(
      current.harness.ctx,
      current.registry,
      current.manager,
      () => Promise.resolve(brittle),
      current.harness.ctx.logger,
    )
    expect(await adapter.handleDirect('/folder /anywhere', KEY)).toBe('not a usable path')
  })
})
describe('TelegramRuntime settings-derived reads', () => {
  let harness: TelegramHarness | undefined
  let runtime: TelegramRuntime | undefined

  afterEach(async () => {
    await runtime?.stop()
    await harness?.dispose()
    harness = undefined
    runtime = undefined
  })

  it('resolves the live reads from the settings section, and their defaults without one', async () => {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const config = runtimeConfig(harness)
    runtime = new TelegramRuntime(harness.ctx, config)
    const internals = runtime as unknown as RuntimeInternals
    expect(internals.renderAgentOptions()).toEqual({ provider: 'mock', model: 'mock' })
    // runtimeConfig carries neither pacing nor timeout values: the defaults answer.
    expect(internals.renderEditInterval()).toBe(1000)
    expect(internals.renderApprovalTimeout()).toBe(600_000)
    Reflect.set(runtime, 'currentConfig', () => ({}) as Config)
    expect(internals.renderAgentOptions()).toEqual({})
    expect(internals.renderEditInterval()).toBe(1000)
    expect(internals.renderApprovalTimeout()).toBe(600_000)
  })

  it('rebuilds the authorization gate from a bare settings section', async () => {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const config = runtimeConfig(harness)
    runtime = new TelegramRuntime(harness.ctx, config)
    await runtime.start()
    // A section that carries neither allowlist resolves with neither: the
    // rebuilt gate must drop everything instead of trusting the entry.
    Reflect.set(runtime, 'currentConfig', () => ({}) as Config)
    ;(runtime as unknown as RuntimeInternals).onSettingsCommitted()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(0)
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
    expect(harness.api.texts()).toHaveLength(0)
  })
})
