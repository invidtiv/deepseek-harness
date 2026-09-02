/**
 * The durable topic→session mapping: a storage-domain unit plus the
 * plugin-private registry over it. Session history itself lives in
 * `ctx.sessionPersistence` and is never duplicated here; this table owns only
 * routing facts (which session, which workspace, which generation).
 * @module @deepseek-ai/dsh-telegram/src/topics
 */

import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { TopicKey, TopicRef } from './types.ts'

/** Session id schema at the durable boundary; branding has no runtime representation. */
const sessionId = z.string().transform(value => value as SessionId)

/**
 * Current mapping for one topic. `sessionId` is null until the topic's first
 * session is created (`/folder` may select a workspace first);
 * `workspace`/`pendingWorkspace` are canonical absolute paths — null until
 * selected. `generation` bumps on every `/reset`; session ids derive from it
 * deterministically so a crash between session creation and mapping write
 * adopts rather than orphans the persisted session.
 */
export const topicRecord = z.object({
  chatId: z.number(),
  threadId: z.number().nullable(),
  sessionId: sessionId.nullable(),
  generation: z.number(),
  workspace: z.string().nullable(),
  pendingWorkspace: z.string().nullable(),
  topicTitle: z.string().optional(),
  createdAt: z.string(),
  lastActivity: z.string(),
})

/** One stored topic mapping record, inferred from {@link topicRecord}. */
export type TopicRecord = z.infer<typeof topicRecord>

/**
 * One retired session of a topic, kept for audit. Written on `/reset` before
 * the current mapping moves on; keyed by `<topicKey>:<generation>`.
 */
export const topicHistoryRecord = z.object({
  chatId: z.number(),
  threadId: z.number().nullable(),
  sessionId,
  workspace: z.string(),
  createdAt: z.string(),
  archivedAt: z.string(),
})

/** One stored history record, inferred from {@link topicHistoryRecord}. */
export type TopicHistoryRecord = z.infer<typeof topicHistoryRecord>

/**
 * The telegram-topics domain spec: one `topics` table keyed by
 * {@link TopicKey} plus one `history` table for `/reset` audit rows. The
 * runtime opens this through `ctx.storageDomain`; the spec object is the
 * single source of the domain's identity, version, and schemas.
 * (Domain names must match the storage unit pattern — no hyphens.)
 */
export const telegramTopicsDomain = defineDomain({
  name: 'telegram_topics',
  version: 1,
  tables: {
    topics: domainTable<TopicKey, TopicRecord>(topicRecord),
    history: domainTable<string, TopicHistoryRecord>(topicHistoryRecord),
  },
})

/**
 * Stable string key for one chat/thread pair; the General topic (absent thread id) maps to `general`.
 * @param chatId - Telegram chat id.
 * @param threadId - Forum topic `message_thread_id`, or `null` for the General topic and plain chats.
 * @returns the mapping-table key for that topic.
 */
export function topicKeyOf(chatId: number, threadId: number | null): TopicKey {
  return `${chatId}:${threadId ?? 'general'}`
}

/**
 * Deterministic session id for one topic generation — the self-healing adoption anchor.
 * @param key - Topic key.
 * @param generation - The topic's current generation, bumped by `/reset`.
 * @returns the session id that generation always derives, so a persisted session is adopted rather than orphaned.
 */
export function sessionIdForKey(key: TopicKey, generation: number): SessionId {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 8)
  return SessionId(`tg-${digest}-${generation}`)
}

/**
 * History-table key for one retired generation.
 * @param key - Topic key.
 * @param generation - The retired generation number.
 * @returns the history-table key holding that generation's audit row.
 */
export function historyKeyOf(key: TopicKey, generation: number): string {
  return `${key}:${generation}`
}

/**
 * Key of one history row, parsed back to its topic key (the row's own fields are authoritative).
 * @param key - Topic key.
 * @returns the shared prefix of every history key belonging to that topic.
 */
export function historyKeyPrefix(key: TopicKey): string {
  return `${key}:`
}

/**
 * The plugin's mapping registry over the opened domain. Owns both write
 * paths (mapping rows, audit rows) and the in-memory session→topic index used
 * to route session events back to a chat target.
 */
export class TopicRegistry {
  private readonly topics: KvTable<TopicKey, TopicRecord>
  private readonly history: KvTable<string, TopicHistoryRecord>
  private readonly sessionIndex = new Map<string, TopicKey>()

  /**
   * @param domain - Already-opened `telegram-topics` domain; the caller closes it.
   */
  constructor(domain: Domain<typeof telegramTopicsDomain>) {
    this.topics = domain.table('topics')
    this.history = domain.table('history')
    for (const [key, record] of this.topics.entries()) {
      if (record.sessionId !== null) this.sessionIndex.set(record.sessionId, key)
    }
  }

  /**
   * Read the current mapping row for a topic.
   * @param key - Topic key.
   * @returns the mapping row, or `undefined` for a topic the plugin never wrote.
   */
  get(key: TopicKey): TopicRecord | undefined {
    return this.topics.get(key)
  }

  /**
   * Write the current mapping row (upsert) and keep the session index consistent.
   * @param key - Topic key.
   * @param record - The complete row to store; it replaces any previous row for the key.
   * @returns resolution after the durable write committed and the session index reflects it.
   */
  async put(key: TopicKey, record: TopicRecord): Promise<void> {
    const previous = this.topics.get(key)
    await this.topics.put(key, record)
    if (previous?.sessionId !== null && previous !== undefined) this.sessionIndex.delete(previous.sessionId)
    if (record.sessionId !== null) this.sessionIndex.set(record.sessionId, key)
  }

  /**
   * Mutate the current mapping row through the table's read-modify-write.
   * @param key - Topic key; a key with no stored row rejects with the table's `missing-key` failure.
   * @param fn - Synchronous pure transform from the current row to its successor.
   * @returns the stored successor row after the durable write committed.
   */
  async update(key: TopicKey, fn: (current: TopicRecord) => TopicRecord): Promise<TopicRecord> {
    const previous = this.topics.get(key)
    const next = await this.topics.update(key, fn)
    if (previous?.sessionId !== null && previous !== undefined) this.sessionIndex.delete(previous.sessionId)
    if (next.sessionId !== null) this.sessionIndex.set(next.sessionId, key)
    return next
  }

  /**
   * Remove one mapping row (topic deleted); the session log is never deleted.
   * @param key - Topic key.
   * @returns `true` when a row existed and was removed, `false` when the key held none.
   */
  async delete(key: TopicKey): Promise<boolean> {
    const previous = this.topics.get(key)
    if (previous?.sessionId !== null && previous !== undefined) this.sessionIndex.delete(previous.sessionId)
    return await this.topics.delete(key)
  }

  /**
   * All current mapping rows, for startup cross-checks and diagnostics.
   * @returns an iterator over key/row pairs of the topics table.
   */
  entries(): IterableIterator<[TopicKey, TopicRecord]> {
    return this.topics.entries()
  }

  /**
   * Topic key owning a live or persisted session id, when mapped.
   * @param sessionId - Session id to reverse-look-up.
   * @returns the owning topic key, or `undefined` when no mapping row carries that session.
   */
  keyOfSession(sessionId: string): TopicKey | undefined {
    return this.sessionIndex.get(sessionId)
  }

  /**
   * Write one audit row for a retired generation.
   * @param key - Topic key.
   * @param generation - The retired generation number.
   * @param record - The audit row describing the retired session.
   * @returns resolution after the audit row committed.
   */
  async putHistory(key: TopicKey, generation: number, record: TopicHistoryRecord): Promise<void> {
    await this.history.put(historyKeyOf(key, generation), record)
  }

  /**
   * Audit rows of one topic in generation order (none for a fresh topic).
   * @param key - Topic key.
   * @returns the topic's audit rows sorted by archive time; empty when the topic never reset.
   */
  historyOf(key: TopicKey): TopicHistoryRecord[] {
    const prefix = historyKeyPrefix(key)
    return [...this.history.entries()]
      .filter(([historyKey]) => historyKey.startsWith(prefix))
      .map(([, record]) => record)
      .sort((left, right) => Date.parse(left.archivedAt) - Date.parse(right.archivedAt))
  }

  /**
   * Parse a topic key back into its chat/thread fields (for logs and cross-checks).
   * @param key - Topic key produced by {@link topicKeyOf}.
   * @returns the chat id and forum thread id the key encodes; `general` decodes to a `null` thread id.
   */
  static parse(key: TopicKey): TopicRef {
    const separator = key.lastIndexOf(':')
    if (separator < 1) throw new Error(`telegram: malformed topic key: ${key}`)
    const chatId = Number(key.slice(0, separator))
    if (!Number.isFinite(chatId)) throw new Error(`telegram: non-numeric chat id in topic key: ${key}`)
    const threadPart = key.slice(separator + 1)
    if (threadPart === 'general') return { chatId, threadId: null }
    const threadId = Number(threadPart)
    if (!Number.isFinite(threadId)) throw new Error(`telegram: non-numeric thread id in topic key: ${key}`)
    return { chatId, threadId }
  }
}
