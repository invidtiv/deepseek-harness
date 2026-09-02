import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { sessionIdForKey, telegramTopicsDomain, TopicRegistry, topicKeyOf } from '../src/topics.ts'
import type { TopicRecord } from '../src/topics.ts'

function record(overrides: Partial<TopicRecord> = {}): TopicRecord {
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

describe('TopicRegistry index maintenance', () => {
  let ctx: Context
  let domain: Domain<typeof telegramTopicsDomain>
  let registry: TopicRegistry

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  async function setup(): Promise<void> {
    ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin({ ...StorageJson, name: 'storage-json' }, { root: await mkdtemp(join(tmpdir(), 'telegram-index-')) })
    await ctx.plugin({ ...StorageDomain, name: 'storage-domain' }, { backend: 'json' })
    domain = await ctx.storageDomain.open(telegramTopicsDomain)
    registry = new TopicRegistry(domain)
  }

  it('indexes only the stored rows that carry a session', async () => {
    await setup()
    const mapped = topicKeyOf(1001, 42)
    const unmapped = topicKeyOf(1001, 43)
    const sessionId = sessionIdForKey(mapped, 1)
    await registry.put(mapped, record({ threadId: 42, sessionId, workspace: '/w' }))
    await registry.put(unmapped, record({ threadId: 43 }))

    const reopened = new TopicRegistry(domain)
    expect(reopened.keyOfSession(sessionId)).toBe(mapped)
    expect([...reopened.entries()].map(([key]) => key)).toEqual([mapped, unmapped])
  })

  it('moves the session index with an in-place row update', async () => {
    await setup()
    const key = topicKeyOf(1001, null)
    const first = sessionIdForKey(key, 1)
    const second = sessionIdForKey(key, 2)
    await registry.put(key, record({ sessionId: first, workspace: '/w' }))
    const updated = await registry.update(key, current => ({ ...current, sessionId: second, generation: 2 }))
    expect(updated.generation).toBe(2)
    expect(registry.keyOfSession(first)).toBeUndefined()
    expect(registry.keyOfSession(second)).toBe(key)
  })

  it('leaves the index untouched when a sessionless row is updated', async () => {
    await setup()
    const key = topicKeyOf(1001, 44)
    await registry.put(key, record({ threadId: 44, topicTitle: 'API work' }))
    const updated = await registry.update(key, current => ({ ...current, topicTitle: 'API work v2' }))
    expect(updated.topicTitle).toBe('API work v2')
    expect(updated.sessionId).toBeNull()
    expect([...registry.entries()]).toHaveLength(1)
  })

  it('removes a sessionless row and reports a missing key', async () => {
    await setup()
    const key = topicKeyOf(1001, 45)
    await registry.put(key, record({ threadId: 45 }))
    expect(await registry.delete(key)).toBe(true)
    expect(await registry.delete(key)).toBe(false)
    expect([...registry.entries()]).toHaveLength(0)
  })

  it('returns a topic history in archive order', async () => {
    await setup()
    const key = topicKeyOf(1001, null)
    await registry.putHistory(key, 2, {
      chatId: 1001,
      threadId: null,
      sessionId: sessionIdForKey(key, 2),
      workspace: '/w',
      createdAt: '2026-01-02T00:00:00.000Z',
      archivedAt: '2026-01-03T00:00:00.000Z',
    })
    await registry.putHistory(key, 1, {
      chatId: 1001,
      threadId: null,
      sessionId: sessionIdForKey(key, 1),
      workspace: '/w',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(registry.historyOf(key).map(row => row.archivedAt)).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ])
  })
})
