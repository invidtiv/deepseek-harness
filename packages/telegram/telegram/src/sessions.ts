/**
 * Topic session lifecycle: live reuse, persisted resume with cwd-conflict
 * refusal, deterministic-id creation/adoption, per-topic pending-input
 * accounting, and teardown. The harness owns session durability and the cwd
 * immutability rule; this manager owns routing and the mapping writes around
 * them.
 * @module @deepseek-ai/dsh-telegram/src/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { sessionIdForKey, TopicRegistry } from './topics.ts'
import type { TopicRecord } from './topics.ts'
import { WorkspaceGuard } from './workspaces.ts'
import type { ChatTarget, TopicKey } from './types.ts'

/** Agent selection for created sessions, mirroring the ACP bridge config. */
export interface TelegramAgentOptions {
  readonly provider?: string
  readonly model?: string
}

/** One live topic: its exact agent, its owned disposer, and per-topic bookkeeping. */
export interface LiveTopic {
  readonly key: TopicKey
  readonly target: ChatTarget
  readonly sessionId: SessionId
  readonly agent: Agent
  readonly dispose: () => Promise<void>
  /** Our followups still sitting in the inbox (submitted, not yet claimed). */
  readonly pending: ReadonlySet<string>
}

interface LiveRecord extends Omit<LiveTopic, 'pending'> {
  pending: Set<string>
}

/** Resolution outcome: either the live topic or a user-presentable refusal. */
export type TopicResolution =
  | { readonly ok: true; readonly topic: LiveTopic }
  | { readonly ok: false; readonly reply: string }

/**
 * Session resolver bound to one domain-backed {@link TopicRegistry} and one
 * workspace guard. `resolve` is the single admission path every message flow
 * uses; mapping writes happen only after the harness committed the session,
 * and a cwd mismatch on resume surfaces an error instead of replacing the
 * session.
 */
export class SessionManager {
  private readonly live = new Map<TopicKey, LiveRecord>()

  /**
   * @param agents - The injected agent registry.
   * @param persistence - Session persistence for resume checks and adoption.
   * @param registry - The topic mapping registry.
   * @param agentOptions - Provider/model selection for created agents, read at admission so a settings change reaches the next session.
   * @param logger - Structured logger; ids only, never content.
   */
  constructor(
    private readonly agents: AgentRegistry,
    private readonly persistence: SessionPersistence,
    private readonly registry: TopicRegistry,
    private readonly agentOptions: () => TelegramAgentOptions,
    private readonly logger: Context['logger'],
  ) {}

  /**
   * The live topic owning an exact agent, when the plugin owns one.
   * @param agent - The agent to identify, matched by identity rather than by session id alone.
   * @returns the owning live topic, or `undefined` when a different agent holds that topic; a session no mapping row
   *   carries throws instead.
   */
  topicForAgent(agent: Agent): LiveTopic | undefined {
    const record = this.live.get(this.keyOf(agent.session.id))
    return record?.agent === agent ? record : undefined
  }

  /**
   * The live topic for a session id.
   * @param sessionId - Session id to look up.
   * @returns the live topic bound to that session, or `undefined` when the topic moved on; a session no mapping row
   *   carries throws instead.
   */
  bySession(sessionId: SessionId): LiveTopic | undefined {
    const record = this.live.get(this.keyOf(sessionId))
    return record?.sessionId === sessionId ? record : undefined
  }

  /**
   * The live topic for a topic key.
   * @param key - Topic key.
   * @returns the live topic, or `undefined` when the topic has no live session.
   */
  byKey(key: TopicKey): LiveTopic | undefined {
    return this.live.get(key)
  }

  /**
   * All live topics.
   * @returns a snapshot array of the live topics; later admissions do not appear in it.
   */
  all(): LiveTopic[] {
    return [...this.live.values()]
  }

  /**
   * Resolve the session for one topic, creating or resuming as needed. On
   * every refusal the mapping is left untouched so the next message retries
   * the same path.
   * @param key - Topic key.
   * @param createWorkspace - Canonical workspace for a first session; when
   *   omitted the mapping's stored or pending workspace is used, and a topic
   *   with no workspace selected refuses with a `/folder` hint.
   * @returns the live topic or a user-presentable refusal.
   */
  async resolve(key: TopicKey, createWorkspace?: string): Promise<TopicResolution> {
    const record = this.registry.get(key)
    if (record?.sessionId !== null && record?.sessionId !== undefined) {
      const live = this.live.get(key)
      if (live !== undefined && live.sessionId === record.sessionId) return { ok: true, topic: live }
      return await this.resumeOrRefuse(key, record)
    }
    const workspace = createWorkspace ?? record?.pendingWorkspace ?? record?.workspace ?? undefined
    if (workspace === undefined) {
      return {
        ok: false,
        reply: 'No workspace selected for this topic. Pick one with /folder (allowed roots only).',
      }
    }
    return await this.createOrAdopt(key, record, workspace)
  }

  /**
   * Submit a followup: register the message id in the topic's pending set.
   * @param topic - The live topic the followup was submitted to.
   * @param messageId - Id of the submitted inbox message; the driver clears it on claim or discard.
   */
  noteSubmitted(topic: LiveTopic, messageId: string): void {
    const record = this.live.get(topic.key)
    if (record !== undefined) record.pending.add(messageId)
  }

  /**
   * The driver claimed one inbox item: it is no longer pending. A session no mapping row carries throws.
   * @param agent - The agent that owns the claimed item; a different agent on the same topic leaves the set untouched.
   * @param messageId - Id of the claimed inbox message; an id already cleared is a no-op.
   */
  noteClaimed(agent: Agent, messageId: string): void {
    const record = this.live.get(this.keyOf(agent.session.id))
    if (record?.agent === agent) record.pending.delete(messageId)
  }

  /**
   * Cancellation discarded one inbox item: it is no longer pending. A session no mapping row carries throws.
   * @param agent - The agent that owns the discarded item; a different agent on the same topic leaves the set untouched.
   * @param messageId - Id of the discarded inbox message; an id already cleared is a no-op.
   */
  noteDiscarded(agent: Agent, messageId: string): void {
    const record = this.live.get(this.keyOf(agent.session.id))
    if (record?.agent === agent) record.pending.delete(messageId)
  }

  /**
   * Queued-but-unclaimed followup count for one topic.
   * @param topic - The live topic to count for.
   * @returns the pending followup count the queue cap is compared against; `0` once the topic is retired.
   */
  pendingCount(topic: LiveTopic): number {
    return this.live.get(topic.key)?.pending.size ?? 0
  }

  /**
   * Retire one topic's live session in place (the `/reset` path): dispose
   * the handle, archive the session in the workspace registry when mounted,
   * and return the facts the caller needs to create the successor.
   * @param topic - The live topic to retire.
   * @param archive - Optional workspace-registry archive call.
   * @returns the retired session id and the canonical workspace the successor should use.
   */
  async retire(
    topic: LiveTopic,
    archive?: (sessionId: SessionId) => Promise<void>,
  ): Promise<{ retired: SessionId; workspace: string }> {
    const row = this.registry.get(topic.key)
    const workspace = row?.pendingWorkspace ?? row?.workspace
    this.live.delete(topic.key)
    await topic.dispose()
    if (archive !== undefined) {
      try {
        await archive(topic.sessionId)
      } catch (error) {
        // Archiving is presentation state; a failure must not block the reset.
        this.logger.warn(`telegram: archive of ${topic.sessionId} failed: ${String(error)}`)
      }
    }
    if (workspace === undefined || workspace === null) {
      throw new Error(`telegram: cannot retire topic ${topic.key}: no workspace selected`)
    }
    return { retired: topic.sessionId, workspace }
  }

  /** Stop every live agent: cancel active work, then dispose the owned handles. */
  async disposeAll(): Promise<void> {
    const records = [...this.live.values()]
    this.live.clear()
    for (const record of records) {
      try {
        record.agent.cancel({ kind: 'user' })
      } catch (error) {
        this.logger.warn(`telegram: cancel of ${record.sessionId} failed: ${String(error)}`)
      }
    }
    await Promise.allSettled(records.map(async (record) => { await record.dispose() }))
  }

  /** Resume a mapped-but-cold session, or refuse with a precise reason. */
  private async resumeOrRefuse(key: TopicKey, record: TopicRecord): Promise<TopicResolution> {
    const sessionId = record.sessionId as SessionId
    const headers = await this.persistence.list()
    const header = headers.find(candidate => candidate.id === sessionId)
    if (header === undefined) {
      return {
        ok: false,
        reply: `Session ${sessionId} has no persisted log. Send /reset to start a fresh session for this topic.`,
      }
    }
    if (header.cwd === undefined || record.workspace === null) {
      return { ok: false, reply: `Session ${sessionId} cannot be resumed: its workspace is not recorded.` }
    }
    let canonical: string
    try {
      canonical = await WorkspaceGuard.canonicalize(header.cwd)
    } catch {
      return {
        ok: false,
        reply: `Session ${sessionId} workspace '${header.cwd}' no longer resolves. Pick a new one with /folder, then /reset.`,
      }
    }
    if (canonical !== record.workspace) {
      return {
        ok: false,
        reply: `Session ${sessionId} was created in workspace '${record.workspace}' but its log records '${header.cwd}'. `
          + 'Workspace changes take a new session: use /reset (the mapping was not replaced).',
      }
    }
    const handle = await this.agents.resume({ resumeSessionId: sessionId, agentOptions: this.agentOptions() })
    this.register(key, sessionId, handle.agent, () => handle.dispose())
    this.logger.info(`telegram: resumed session ${sessionId} for topic ${key}`)
    return { ok: true, topic: this.requireLive(key) }
  }

  /**
   * Create a fresh session on a deterministic id, adopting a persisted
   * session that already carries it (a crash between create and mapping
   * write). The mapping row is written only after the harness committed the
   * session, so a failed create leaves no dangling mapping.
   */
  private async createOrAdopt(
    key: TopicKey,
    record: TopicRecord | undefined,
    workspace: string,
  ): Promise<TopicResolution> {
    const generation = record?.generation ?? 1
    const sessionId = sessionIdForKey(key, generation)
    const ref = TopicRegistry.parse(key)
    const now = new Date().toISOString()
    const next: TopicRecord = {
      chatId: ref.chatId,
      threadId: ref.threadId,
      sessionId,
      generation,
      workspace,
      pendingWorkspace: record?.pendingWorkspace ?? null,
      ...record?.topicTitle !== undefined ? { topicTitle: record.topicTitle } : {},
      createdAt: record?.createdAt ?? now,
      lastActivity: now,
    }
    const handle = await this.createHandle(sessionId, workspace)
    try {
      await this.registry.put(key, next)
    } catch (error) {
      await handle.dispose()
      throw error
    }
    this.register(key, sessionId, handle.agent, () => handle.dispose())
    this.logger.info(`telegram: created session ${sessionId} for topic ${key} in workspace '${workspace}'`)
    return { ok: true, topic: this.requireLive(key) }
  }

  /** Create the session handle, adopting an already-persisted deterministic id. */
  private async createHandle(
    sessionId: SessionId,
    workspace: string,
  ): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
    const headers = await this.persistence.list()
    if (headers.some(header => header.id === sessionId)) {
      this.logger.info(`telegram: adopting persisted session ${sessionId}`)
      return await this.agents.resume({ resumeSessionId: sessionId, agentOptions: this.agentOptions() })
    }
    return await this.agents.create({
      sessionId,
      meta: { cwd: workspace },
      agentOptions: this.agentOptions(),
    })
  }

  private register(key: TopicKey, sessionId: SessionId, agent: Agent, dispose: () => Promise<void>): void {
    this.live.set(key, {
      key,
      target: TopicRegistry.parse(key),
      sessionId,
      agent,
      dispose,
      pending: new Set(),
    })
  }

  private requireLive(key: TopicKey): LiveTopic {
    const record = this.live.get(key)
    if (record === undefined) throw new Error(`telegram: topic ${key} has no live session after admission`)
    return record
  }

  private keyOf(sessionId: SessionId): TopicKey {
    const key = this.registry.keyOfSession(sessionId)
    if (key === undefined) throw new Error(`telegram: session ${sessionId} is not mapped to any topic`)
    return key
  }
}
