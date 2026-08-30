import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionManager } from '../src/sessions.ts'
import type { LiveTopic } from '../src/sessions.ts'
import { sessionIdForKey, telegramTopicsDomain, TopicRegistry, topicKeyOf } from '../src/topics.ts'
import type { TopicRecord } from '../src/topics.ts'
import { makeTelegramHarness, textResponse, type TelegramHarness } from './harness.ts'

const KEY = topicKeyOf(1001, null)

interface Fixture {
  readonly harness: TelegramHarness
  readonly registry: TopicRegistry
  readonly manager: SessionManager
  readonly workspace: string
}

async function fixture(script: StreamChunk[][] = []): Promise<Fixture> {
  const harness = await makeTelegramHarness({ mountPlugin: false, script })
  const domain = await harness.ctx.storageDomain.open(telegramTopicsDomain)
  const registry = new TopicRegistry(domain)
  const manager = new SessionManager(
    harness.ctx.agents,
    harness.ctx.sessionPersistence,
    registry,
    () => ({ provider: 'mock', model: 'mock' }),
    harness.ctx.logger,
  )
  return { harness, registry, manager, workspace: harness.roots[0] as string }
}

function row(overrides: Partial<TopicRecord> = {}): TopicRecord {
  return {
    chatId: 1001,
    threadId: null,
    sessionId: null,
    generation: 1,
    workspace: null,
    pendingWorkspace: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** The live topic of a resolution, or a failure naming the refusal. */
async function admitted(fixtureValue: Fixture, workspace?: string): Promise<LiveTopic> {
  const resolution = await fixtureValue.manager.resolve(KEY, workspace)
  if (!resolution.ok) throw new Error(`unexpected refusal: ${resolution.reply}`)
  return resolution.topic
}

describe('SessionManager live topics', () => {
  let current: Fixture | undefined

  afterEach(async () => {
    await current?.manager.disposeAll()
    await current?.harness.dispose()
    current = undefined
  })

  it('creates one session per topic and answers every lookup for it', async () => {
    current = await fixture()
    const topic = await admitted(current, current.workspace)
    expect(current.manager.all()).toEqual([topic])
    expect(current.manager.byKey(KEY)).toBe(topic)
    expect(current.manager.bySession(topic.sessionId)).toBe(topic)
    expect(current.manager.topicForAgent(topic.agent)).toBe(topic)
    expect(await admitted(current)).toBe(topic)
    expect(current.registry.get(KEY)?.workspace).toBe(current.workspace)
  })

  it('refuses a topic that has no workspace to create in', async () => {
    current = await fixture()
    const resolution = await current.manager.resolve(KEY)
    expect(resolution).toEqual({
      ok: false,
      reply: 'No workspace selected for this topic. Pick one with /folder (allowed roots only).',
    })
  })

  it('adopts the stored topic title when the first session is created', async () => {
    current = await fixture()
    await current.registry.put(KEY, row({ topicTitle: 'API work', pendingWorkspace: current.workspace }))
    const topic = await admitted(current)
    expect(current.registry.get(KEY)?.topicTitle).toBe('API work')
    expect(topic.sessionId).toBe(sessionIdForKey(KEY, 1))
  })

  it('counts only followups of the live topic', async () => {
    current = await fixture()
    const topic = await admitted(current, current.workspace)
    current.manager.noteSubmitted(topic, 'message-1')
    current.manager.noteSubmitted(topic, 'message-2')
    expect(current.manager.pendingCount(topic)).toBe(2)
    current.manager.noteClaimed(topic.agent, 'message-1')
    current.manager.noteDiscarded(topic.agent, 'message-2')
    expect(current.manager.pendingCount(topic)).toBe(0)

    await current.manager.disposeAll()
    current.manager.noteSubmitted(topic, 'message-3')
    expect(current.manager.pendingCount(topic)).toBe(0)
  })

  it('treats another agent on the same topic as unowned', async () => {
    current = await fixture()
    const topic = await admitted(current, current.workspace)
    const other = await current.harness.ctx.agents.create({
      sessionId: SessionId('telegram-unit-other'),
      meta: { cwd: current.workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const stored = current.registry.get(KEY) as TopicRecord
    await current.registry.put(KEY, { ...stored, sessionId: other.agent.session.id })

    expect(current.manager.topicForAgent(other.agent)).toBeUndefined()
    expect(current.manager.bySession(other.agent.session.id)).toBeUndefined()
    current.manager.noteSubmitted(topic, 'message-1')
    current.manager.noteClaimed(other.agent, 'message-1')
    current.manager.noteDiscarded(other.agent, 'message-1')
    expect(current.manager.pendingCount(topic)).toBe(1)
    await other.dispose()
  })

  it('rejects a lookup for a session no mapping row carries', async () => {
    current = await fixture()
    const unmapped = { session: { id: SessionId('telegram-unit-unmapped') } } as unknown as Agent
    expect(() => current?.manager.topicForAgent(unmapped)).toThrow(/is not mapped to any topic/u)
  })

  it('cancels and disposes every live topic, even when a cancel throws', async () => {
    current = await fixture()
    const topic = await admitted(current, current.workspace)
    vi.spyOn(topic.agent, 'cancel').mockImplementation(() => { throw new Error('cancel refused') })
    await current.manager.disposeAll()
    expect(current.manager.all()).toEqual([])
    expect(current.harness.ctx.agents.list()).toHaveLength(0)
  })
})

describe('SessionManager resume refusals', () => {
  let current: Fixture | undefined

  afterEach(async () => {
    await current?.manager.disposeAll()
    await current?.harness.dispose()
    current = undefined
  })

  /** Persist one session with a completed turn in `cwd` and return its id. */
  async function persisted(fixtureValue: Fixture, cwd: string): Promise<SessionId> {
    const sessionId = sessionIdForKey(KEY, 1)
    const handle = await fixtureValue.harness.ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await fixtureValue.harness.ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    return sessionId
  }

  it('refuses a mapped session that has no persisted log', async () => {
    current = await fixture()
    await current.registry.put(KEY, row({ sessionId: sessionIdForKey(KEY, 1), workspace: current.workspace }))
    const resolution = await current.manager.resolve(KEY)
    expect(resolution.ok).toBe(false)
    expect(resolution.ok ? '' : resolution.reply).toContain('has no persisted log')
  })

  it('refuses a mapped session whose workspace was never recorded', async () => {
    current = await fixture([textResponse('seeded')])
    const sessionId = await persisted(current, current.workspace)
    await current.registry.put(KEY, row({ sessionId, workspace: null }))
    const resolution = await current.manager.resolve(KEY)
    expect(resolution.ok).toBe(false)
    expect(resolution.ok ? '' : resolution.reply).toContain('its workspace is not recorded')
  })

  it('refuses a mapped session whose recorded workspace no longer resolves', async () => {
    current = await fixture([textResponse('seeded')])
    const vanishing = await mkdtemp(join(tmpdir(), 'telegram-vanishing-'))
    const sessionId = await persisted(current, vanishing)
    await current.registry.put(KEY, row({ sessionId, workspace: current.workspace }))
    await rm(vanishing, { recursive: true, force: true })
    const resolution = await current.manager.resolve(KEY)
    expect(resolution.ok).toBe(false)
    expect(resolution.ok ? '' : resolution.reply).toContain('no longer resolves')
  })

  it('disposes the created session when the mapping write fails', async () => {
    current = await fixture()
    // The mapping row cannot be published once its storage directory is gone,
    // while the in-memory reads the admission path needs still answer.
    await rm(current.harness.storageRoot, { recursive: true, force: true })
    await expect(current.manager.resolve(KEY, current.workspace)).rejects.toThrow(/ENOENT/u)
    expect(current.harness.ctx.agents.list()).toHaveLength(0)
  })
})

describe('SessionManager retirement', () => {
  let current: Fixture | undefined

  afterEach(async () => {
    await current?.manager.disposeAll()
    await current?.harness.dispose()
    current = undefined
  })

  it('archives the retired session through the supplied callback', async () => {
    current = await fixture()
    const topic = await admitted(current, current.workspace)
    const archived: SessionId[] = []
    const retired = await current.manager.retire(topic, async (sessionId) => { archived.push(sessionId) })
    expect(retired).toEqual({ retired: topic.sessionId, workspace: current.workspace })
    expect(archived).toEqual([topic.sessionId])
    expect(current.manager.byKey(KEY)).toBeUndefined()
  })

  it('retires the session even when archiving fails', async () => {
    current = await fixture()
    const topic = await admitted(current, current.workspace)
    const retired = await current.manager.retire(topic, () => Promise.reject(new Error('registry refused')))
    expect(retired.retired).toBe(topic.sessionId)
    expect(current.manager.all()).toEqual([])
  })

  it('refuses to retire a topic with no workspace on record', async () => {
    current = await fixture()
    const topic = await admitted(current, current.workspace)
    const stored = current.registry.get(KEY) as TopicRecord
    await current.registry.put(KEY, { ...stored, workspace: null, pendingWorkspace: null })
    await expect(current.manager.retire(topic)).rejects.toThrow(/no workspace selected/u)
  })
})
