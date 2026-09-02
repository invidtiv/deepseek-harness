import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  historyKeyOf,
  sessionIdForKey,
  telegramTopicsDomain,
  TopicRegistry,
  topicKeyOf,
} from '../src/topics.ts'
import type { TopicRecord } from '../src/topics.ts'
import { topicRecord } from '../src/topics.ts'

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

describe('TopicRegistry', () => {
  let ctx: Context
  let registry: TopicRegistry

  afterEach(async () => {
    await ctx?.fiber.dispose()
  })

  async function setup(): Promise<void> {
    ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin({ ...StorageJson, name: 'storage-json' }, { root: await mkdtemp(join(tmpdir(), 'telegram-topics-')) })
    await ctx.plugin({ ...StorageDomain, name: 'storage-domain' }, { backend: 'json' })
    const domain = await ctx.storageDomain.open(telegramTopicsDomain)
    registry = new TopicRegistry(domain)
  }

  it('derives stable topic keys and deterministic session ids', () => {
    expect(topicKeyOf(1001, null)).toBe('1001:general')
    expect(topicKeyOf(1001, 42)).toBe('1001:42')
    const key = topicKeyOf(7, 9)
    expect(sessionIdForKey(key, 1)).toBe(sessionIdForKey(key, 1))
    expect(sessionIdForKey(key, 1)).toMatch(/^tg-[0-9a-f]{8}-1$/u)
    expect(sessionIdForKey(key, 2)).not.toBe(sessionIdForKey(key, 1))
  })

  it('validates records at the durable boundary', () => {
    expect(topicRecord.safeParse({ sessionId: 'x', generation: 'not-a-number' }).success).toBe(false)
    expect(topicRecord.safeParse(record({ sessionId: SessionId('tg-x-1'), generation: 1 })).success).toBe(true)
  })

  it('writes mapping rows, indexes sessions, and archives history', async () => {
    await setup()
    const key = topicKeyOf(1001, 42)
    const sessionId = sessionIdForKey(key, 1)
    await registry.put(key, record({ sessionId, generation: 1, workspace: '/w' }))
    expect(registry.get(key)?.sessionId).toBe(sessionId)
    expect(registry.keyOfSession(sessionId)).toBe(key)

    await registry.putHistory(key, 1, {
      chatId: 1001,
      threadId: 42,
      sessionId,
      workspace: '/w',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(registry.historyOf(key)).toHaveLength(1)
    expect(registry.historyOf(key)[0]?.sessionId).toBe(sessionId)
    expect(registry.historyOf(topicKeyOf(1001, 43))).toHaveLength(0)
    expect(historyKeyOf(key, 1)).toBe(`${key}:1`)
  })

  it('keeps the session index consistent across replaces and deletes', async () => {
    await setup()
    const key = topicKeyOf(1001, null)
    const first = sessionIdForKey(key, 1)
    const second = sessionIdForKey(key, 2)
    await registry.put(key, record({ sessionId: first, workspace: '/w' }))
    await registry.put(key, record({ sessionId: second, generation: 2, workspace: '/w' }))
    expect(registry.keyOfSession(first)).toBeUndefined()
    expect(registry.keyOfSession(second)).toBe(key)
    await registry.delete(key)
    expect(registry.get(key)).toBeUndefined()
    expect(registry.keyOfSession(second)).toBeUndefined()
  })

  it('parses topic keys back into chat and thread ids', () => {
    expect(TopicRegistry.parse('1001:general')).toEqual({ chatId: 1001, threadId: null })
    expect(TopicRegistry.parse('1001:42')).toEqual({ chatId: 1001, threadId: 42 })
  })

  it('rejects malformed topic keys at the durable boundary', () => {
    expect(() => TopicRegistry.parse('')).toThrow('malformed topic key')
    expect(() => TopicRegistry.parse('abc:def')).toThrow('non-numeric chat id')
    expect(() => TopicRegistry.parse('1001:xyz')).toThrow('non-numeric thread id')
    expect(() => TopicRegistry.parse('nocolon')).toThrow('malformed topic key')
  })
})
