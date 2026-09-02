/**
 * Plugin configuration schema for `@deepseek-ai/dsh-telegram`.
 *
 * Secrets are credential references (environment-variable names), never
 * values; `tokenRef` follows the LLM adapter `apiKeyEnv` idiom and the token
 * resolves per operation through `ctx.credentials`.
 * @module @deepseek-ai/dsh-telegram/src/config
 */

import Schema from '@deepseek-ai/schemastery'
import type { TelegramApi } from './bot.ts'

/** Telegram long-poll timeout ceiling (Bot API seconds cap). */
export const MAX_POLL_TIMEOUT_MS = 50_000

/** Telegram hard limit on message text length (characters, not bytes). */
export const MAX_MESSAGE_CHARS = 4096

/** Default placeholder-edit cadence floor: Telegram edits are cheap but flood-sensitive. */
export const DEFAULT_EDIT_INTERVAL_MS = 1000

/** Default unanswered-approval/question timeout: fail closed like the harness's missing answerer. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000

/** Default queued-message cap per topic before the bot answers busy instead of queueing. */
export const DEFAULT_QUEUE_CAP = 3

/** Bot API download limit for inbound documents. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

/** The schemastery schema the Loader validates this plugin's config against. */
export const Config = Schema.object({
  tokenRef: Schema.string().role('credential-ref').default('TELEGRAM_BOT_TOKEN'),
  apiBase: Schema.string(),
  allowedChatIds: Schema.array(Schema.number()).default([]),
  allowedUserIds: Schema.array(Schema.number()).default([]),
  workspaceRoots: Schema.array(Schema.string()).default([]),
  defaultWorkspace: Schema.string(),
  workspaceTopicsChatId: Schema.number().step(1),
  pollTimeoutMs: Schema.number().min(1000).max(MAX_POLL_TIMEOUT_MS).default(25_000),
  queueCap: Schema.number().step(1).min(1).default(DEFAULT_QUEUE_CAP),
  editIntervalMs: Schema.number().min(250).default(DEFAULT_EDIT_INTERVAL_MS),
  approvalTimeoutMs: Schema.number().min(1000).default(DEFAULT_APPROVAL_TIMEOUT_MS),
  agentOptions: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }),
})

/** The schema is the validation authority; the interface below restates its fields optionally (the llm-deepseek Config idiom). */

/**
 * Plugin configuration. Validation is schemastery; the two allowlists and the
 * workspace roots are runtime-validated again in `apply` because empty values
 * are load-time misconfiguration for this plugin specifically.
 */
export interface Config {
  /** Credential reference (POSIX env-var name) holding the bot token; defaults to `TELEGRAM_BOT_TOKEN`. */
  tokenRef?: string
  /** Bot API base URL; default `https://api.telegram.org`. */
  apiBase?: string
  /** Chat ids allowed to drive a topic; absent/empty plus empty `allowedUserIds` fails load. */
  allowedChatIds?: number[]
  /** User ids allowed to drive a topic. */
  allowedUserIds?: number[]
  /** Absolute directory roots a topic workspace may select from; empty fails load. */
  workspaceRoots?: string[]
  /** Workspace used for first-message creation when the topic never ran `/folder`. */
  defaultWorkspace?: string
  /**
   * Forum supergroup where the bot creates one topic per workspace created in
   * this deployment; absent disables workspace-topic creation. Requires the
   * workspace registry in the composition and the bot's `can_manage_topics`
   * right in that chat; with a non-empty `allowedChatIds` the chat must be
   * listed there.
   */
  workspaceTopicsChatId?: number
  /** Long-poll wait in milliseconds; bounded by the Bot API 50-second cap. */
  pollTimeoutMs?: number
  /** Queued-message cap per topic; beyond it the bot answers busy instead of queueing. */
  queueCap?: number
  /** Minimum interval between placeholder edits for one topic. */
  editIntervalMs?: number
  /** Unanswered approval/question timeout; resolves fail-closed. */
  approvalTimeoutMs?: number
  /** Provider/model selection for created agents, mirroring the ACP bridge. */
  agentOptions?: {
    /** LLM provider key for created agents; omitted leaves the composition's default route. */
    provider?: string
    /** Model id for created agents; image input is offered only when this route declares it. */
    model?: string
  }
  /** Runtime-only transport override for tests. */
  transport?: TelegramApi
}
