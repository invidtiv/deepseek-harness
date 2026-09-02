/**
 * Workspace→topic creation: one Telegram forum topic per workspace created in
 * this deployment. The bridge observes the workspace domain's durable change
 * stream, fences every path through the plugin's workspace-root guard, and
 * writes the created topic's mapping row with `pendingWorkspace` set so the
 * topic's first message opens its session in that workspace.
 * @module @deepseek-ai/dsh-telegram/src/workspace-topics
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TelegramApi } from './bot.ts'
import type { Config } from './config.ts'
import { topicKeyOf } from './topics.ts'
import type { TopicRegistry } from './topics.ts'
import type { WorkspaceGuard } from './workspaces.ts'

/** Bot API bound on a forum topic name (characters). */
export const MAX_TOPIC_NAME_CHARS = 128

/** The collaborators the bridge reads per event, resolved live so settings commits apply without a restart. */
export interface WorkspaceTopicDeps {
  /** The transport in force (settings may not replace it, but the runtime owns the instance). */
  readonly api: () => TelegramApi
  /** The plugin's topic mapping registry. */
  readonly registry: TopicRegistry
  /** Workspace lookup by id on the mounted workspace registry. */
  readonly workspaceById: (id: WorkspaceId) => Workspace | undefined
  /** The workspace-root guard for the roots currently in force. */
  readonly guard: () => Promise<WorkspaceGuard>
  /** The resolved configuration section in force. */
  readonly config: () => Config
  /** Structured logger; ids and outcomes only. */
  readonly logger: Context['logger']
}

/**
 * Listener over `domain/changed` that creates one forum topic per workspace
 * creation. Purely additive: it never posts into the topic, and every refusal
 * (feature off, chat not allowed, path outside the roots, workspace already
 * mapped) leaves the mapping table untouched.
 */
export class WorkspaceTopicBridge {
  /** @param deps - Live collaborator reads; see {@link WorkspaceTopicDeps}. */
  constructor(private readonly deps: WorkspaceTopicDeps) {}

  /**
   * Handle one durable domain change; only a `put` of a `workspace`-domain
   * row whose snapshot is a creation write (`createdAt` equals `updatedAt`)
   * creates a topic.
   * @param change - The durable change the domain backend acknowledged.
   * @returns resolution once the event is fully handled; failures are logged, never thrown.
   */
  async onDomainChanged(change: DomainChanged): Promise<void> {
    if (change.domain !== 'workspace' || change.table !== 'workspaces' || change.operation !== 'put') return
    const config = this.deps.config()
    const chatId = config.workspaceTopicsChatId
    if (chatId === undefined) return
    const allowedChats = config.allowedChatIds ?? []
    if (allowedChats.length > 0 && !allowedChats.includes(chatId)) {
      this.deps.logger.warn(`telegram: workspaceTopicsChatId ${chatId} is not in allowedChatIds; workspace topic skipped`)
      return
    }
    // The key of a workspace-domain table row is its WorkspaceId; the durable event carries it as a bare string.
    const workspace = this.deps.workspaceById(change.key as WorkspaceId)
    if (workspace === undefined || workspace.createdAt !== workspace.updatedAt) return
    const guard = await this.deps.guard()
    if (!guard.containsCanonical(workspace.path)) {
      this.deps.logger.info(`telegram: workspace ${workspace.id} lies outside the configured roots; no topic created`)
      return
    }
    for (const [, record] of this.deps.registry.entries()) {
      if (record.workspace === workspace.path || record.pendingWorkspace === workspace.path) return
    }
    const name = workspace.title.slice(0, MAX_TOPIC_NAME_CHARS)
    try {
      const topic = await this.deps.api().createForumTopic(chatId, name === '' ? 'workspace' : name)
      const key = topicKeyOf(chatId, topic.message_thread_id)
      const now = new Date().toISOString()
      await this.deps.registry.put(key, {
        chatId,
        threadId: topic.message_thread_id,
        sessionId: null,
        generation: 1,
        workspace: null,
        pendingWorkspace: workspace.path,
        topicTitle: topic.name,
        createdAt: now,
        lastActivity: now,
      })
      this.deps.logger.info(`telegram: created topic ${key} for workspace ${workspace.id}`)
    } catch (error) {
      this.deps.logger.error(`telegram: topic creation for workspace ${workspace.id} failed: ${String(error)}`)
    }
  }
}
