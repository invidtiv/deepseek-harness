/**
 * Workspace→topic creation: one forum topic per workspace created in the
 * deployment, its mapping row primed with `pendingWorkspace`, and every
 * refusal (feature off, chat not allowed, path outside roots, path already
 * mapped, unknown id, transport failure) leaving the mapping table untouched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { TelegramRuntime } from '../src/index.ts'
import type { TelegramApi } from '../src/bot.ts'
import type { TopicRegistry } from '../src/topics.ts'
import { MAX_TOPIC_NAME_CHARS, WorkspaceTopicBridge } from '../src/workspace-topics.ts'
import type { WorkspaceTopicDeps } from '../src/workspace-topics.ts'
import type { WorkspaceGuard } from '../src/workspaces.ts'
import {
  FORUM_TOPIC,
  GENERAL_TOPIC,
  makeTelegramHarness,
  textResponse,
  textUpdate,
  type TelegramHarness,
} from './harness.ts'

function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 8000, interval: 25 })
}

/** Drain the event dispatch and its queued microtasks so a negative assertion is meaningful. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Recorded topic-creation calls, oldest first. */
function createdTopics(harness: TelegramHarness): Array<{ chatId: number; threadId: number | null; name: string | undefined }> {
  return harness.api.sent
    .filter(send => send.method === 'createForumTopic')
    .map(send => ({ chatId: send.target.chatId, threadId: send.target.threadId, name: send.text }))
}

describe('workspace→topic creation (runtime)', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('creates one topic per created workspace and opens its first session there', async () => {
    harness = await makeTelegramHarness({
      workspaceRegistry: true,
      script: [textResponse('hi from workspace')],
      config: { workspaceTopicsChatId: GENERAL_TOPIC.chatId },
    })
    await harness.api.waitForPoll()
    const dir = join(harness.roots[0] as string, 'proj-a')
    await mkdir(dir)
    const workspace = await harness.workspaces?.create(dir)
    await waitFor(() => { expect(createdTopics(harness as TelegramHarness)).toHaveLength(1) })
    const call = createdTopics(harness)[0] as { chatId: number; threadId: number; name: string }
    expect(call.chatId).toBe(GENERAL_TOPIC.chatId)
    expect(call.name).toBe('proj-a')

    harness.api.push(textUpdate(1, { chatId: GENERAL_TOPIC.chatId, threadId: call.threadId }, 'hello'))
    await waitFor(() => { expect((harness as TelegramHarness).api.texts()).toContain('hi from workspace') })
    harness.api.push(textUpdate(2, { chatId: GENERAL_TOPIC.chatId, threadId: call.threadId }, '/status'))
    await waitFor(() => {
      const texts = (harness as TelegramHarness).api.texts()
      expect(texts.some(text => text.includes((workspace as Workspace).path))).toBe(true)
    })
  }, 45000)

  it('creates no second topic when a created workspace is later mutated', async () => {
    harness = await makeTelegramHarness({
      workspaceRegistry: true,
      config: { workspaceTopicsChatId: GENERAL_TOPIC.chatId },
    })
    await harness.api.waitForPoll()
    const dir = join(harness.roots[0] as string, 'proj-b')
    await mkdir(dir)
    const workspace = await harness.workspaces?.create(dir)
    await waitFor(() => { expect(createdTopics(harness as TelegramHarness)).toHaveLength(1) })
    await workspace?.setTitle('renamed')
    await settle()
    expect(createdTopics(harness)).toHaveLength(1)
  }, 45000)

  it('creates no topic for a workspace whose path a topic already maps', async () => {
    harness = await makeTelegramHarness({
      workspaceRegistry: true,
      script: [textResponse('ok')],
      config: { workspaceTopicsChatId: GENERAL_TOPIC.chatId },
    })
    await harness.api.waitForPoll()
    // The sole root is the implicit default workspace: one message maps it to this topic.
    harness.api.push(textUpdate(1, FORUM_TOPIC, 'work here'))
    await waitFor(() => { expect((harness as TelegramHarness).api.texts()).toContain('ok') })
    await harness.workspaces?.create(harness.roots[0] as string)
    await settle()
    expect(createdTopics(harness)).toHaveLength(0)
  }, 45000)

  it('rejects startup when the chat is configured without the workspace registry', async () => {
    harness = await makeTelegramHarness({
      mountPlugin: false,
      config: { workspaceTopicsChatId: GENERAL_TOPIC.chatId },
    })
    const runtime = new TelegramRuntime(harness.ctx, harness.config)
    await expect(runtime.start()).rejects.toThrow(/requires the workspace registry/u)
  })

  it('rejects construction when the chat is missing from a non-empty allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telegram-wt-'))
    expect(() => new TelegramRuntime(new Context(), {
      allowedChatIds: [GENERAL_TOPIC.chatId],
      allowedUserIds: [],
      workspaceRoots: [root],
      workspaceTopicsChatId: 4242,
    })).toThrow(/workspaceTopicsChatId must be listed in allowedChatIds/u)
  })
})

describe('WorkspaceTopicBridge (unit)', () => {
  /** A creation-write workspace snapshot; `createdAt` equals `updatedAt`. */
  function workspaceOf(path: string, title: string, updatedAt = '2026-01-01T00:00:00.000Z'): Workspace {
    return {
      id: 'ws-1',
      path,
      title,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt,
      sessionIds: [],
    } as unknown as Workspace
  }

  /** A `workspaces`-table put for one workspace id. */
  function putOf(key = 'ws-1'): DomainChanged {
    return { domain: 'workspace', table: 'workspaces', key, operation: 'put', value: {} } as DomainChanged
  }

  function makeBridge(overrides: Partial<WorkspaceTopicDeps> = {}) {
    const createForumTopic = vi.fn(async (_chatId: number, name: string) => ({ message_thread_id: 77, name }))
    const put = vi.fn(async () => {})
    const entries = vi.fn(() => [][Symbol.iterator]())
    const workspaceById = vi.fn((): Workspace | undefined => workspaceOf('/w/a', 'proj'))
    const guard = vi.fn(() => Promise.resolve({ containsCanonical: () => true } as unknown as WorkspaceGuard))
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Context['logger']
    const bridge = new WorkspaceTopicBridge({
      api: () => ({ createForumTopic } as unknown as TelegramApi),
      registry: { entries, put } as unknown as TopicRegistry,
      workspaceById,
      guard,
      config: () => ({ workspaceTopicsChatId: 42 }),
      logger,
      ...overrides,
    })
    return { bridge, createForumTopic, put, entries, workspaceById, guard, logger }
  }

  it('ignores changes that are not workspace-table puts', async () => {
    const { bridge, workspaceById } = makeBridge()
    await bridge.onDomainChanged({ domain: 'telegram_topics', table: 'topics', key: 'k', operation: 'put', value: {} } as DomainChanged)
    await bridge.onDomainChanged({ domain: 'workspace', table: '', key: '', operation: 'put', value: {} } as DomainChanged)
    await bridge.onDomainChanged({ domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'deleted' } as DomainChanged)
    expect(workspaceById).not.toHaveBeenCalled()
  })

  it('does nothing while no workspace chat is configured', async () => {
    const { bridge, workspaceById } = makeBridge({ config: () => ({}) })
    await bridge.onDomainChanged(putOf())
    expect(workspaceById).not.toHaveBeenCalled()
  })

  it('warns and skips when the configured chat is missing from a non-empty allowlist', async () => {
    const { bridge, workspaceById, logger } = makeBridge({
      config: () => ({ workspaceTopicsChatId: 42, allowedChatIds: [1] }),
    })
    await bridge.onDomainChanged(putOf())
    expect(workspaceById).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not in allowedChatIds'))
  })

  it('ignores an unknown workspace id and a non-creation snapshot', async () => {
    const { bridge, guard, workspaceById } = makeBridge()
    workspaceById.mockReturnValueOnce(undefined)
    await bridge.onDomainChanged(putOf())
    workspaceById.mockReturnValueOnce(workspaceOf('/w/a', 'proj', '2026-01-02T00:00:00.000Z'))
    await bridge.onDomainChanged(putOf())
    expect(guard).not.toHaveBeenCalled()
  })

  it('skips a workspace outside the configured roots', async () => {
    const { bridge, entries, logger } = makeBridge({
      guard: () => Promise.resolve({ containsCanonical: () => false } as unknown as WorkspaceGuard),
    })
    await bridge.onDomainChanged(putOf())
    expect(entries).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('outside the configured roots'))
  })

  it('creates nothing when another topic already maps or queues the workspace path', async () => {
    const rows = [
      ['1:1', { workspace: '/other', pendingWorkspace: null }],
      ['1:2', { workspace: null, pendingWorkspace: '/w/a' }],
    ]
    const { bridge, createForumTopic } = makeBridge({
      registry: { entries: () => rows[Symbol.iterator]() } as unknown as TopicRegistry,
    })
    await bridge.onDomainChanged(putOf())
    expect(createForumTopic).not.toHaveBeenCalled()
  })

  it('creates the topic with a clamped name and primes the mapping with pendingWorkspace', async () => {
    const { bridge, createForumTopic, put } = makeBridge({
      workspaceById: () => workspaceOf('/w/a', 'x'.repeat(200)),
    })
    await bridge.onDomainChanged(putOf())
    expect(createForumTopic).toHaveBeenCalledWith(42, 'x'.repeat(MAX_TOPIC_NAME_CHARS))
    expect(put).toHaveBeenCalledWith('42:77', expect.objectContaining({
      chatId: 42,
      threadId: 77,
      sessionId: null,
      generation: 1,
      workspace: null,
      pendingWorkspace: '/w/a',
      topicTitle: 'x'.repeat(MAX_TOPIC_NAME_CHARS),
    }))
  })

  it('names the topic "workspace" when the title is empty', async () => {
    const { bridge, createForumTopic } = makeBridge({
      workspaceById: () => workspaceOf('/w/a', ''),
    })
    await bridge.onDomainChanged(putOf())
    expect(createForumTopic).toHaveBeenCalledWith(42, 'workspace')
  })

  it('logs a transport failure and writes no mapping row', async () => {
    const createForumTopic = vi.fn(async () => { throw new Error('boom') })
    const { bridge, put, logger } = makeBridge({
      api: () => ({ createForumTopic } as unknown as TelegramApi),
    })
    await bridge.onDomainChanged(putOf())
    expect(put).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('topic creation for workspace'))
  })
})
