/**
 * Fail-closed sender authorization: a chat and its sender must both be
 * allowlisted, or the update is dropped before any session work happens.
 * Empty allowlists fail plugin load, so this gate always has at least one
 * configured side.
 * @module @deepseek-ai/dsh-telegram/src/authz
 */

import type { Update } from './types.ts'

/** Decision plus a log-only reason; never message content. */
export interface AuthzDecision {
  readonly allowed: boolean
  readonly reason: string
}

/** Resolve the chat id an update addresses, whichever carrier it uses. */
function chatIdOf(update: Update): number | undefined {
  if (update.message !== undefined) return update.message.chat.id
  if (update.edited_message !== undefined) return update.edited_message.chat.id
  if (update.callback_query?.message !== undefined) return update.callback_query.message.chat.id
  return undefined
}

/** Resolve the acting user id, preferring the message sender over the callback author. */
function userIdOf(update: Update): number | undefined {
  if (update.message !== undefined) return update.message.from?.id
  if (update.edited_message !== undefined) return update.edited_message.from?.id
  if (update.callback_query !== undefined) return update.callback_query.from.id
  return undefined
}

/**
 * Immutable allowlist gate. Chat and user checks are independent: a
 * chat-only deployment leaves `allowedUserIds` empty and vice versa; a
 * sender must pass whichever lists are configured.
 */
export class AuthzGate {
  private readonly chats: ReadonlySet<number>
  private readonly users: ReadonlySet<number>

  /**
   * @param allowedChatIds - Chat ids that may drive topics; empty means chat-agnostic.
   * @param allowedUserIds - User ids that may drive topics; empty means user-agnostic.
   */
  constructor(allowedChatIds: readonly number[], allowedUserIds: readonly number[]) {
    this.chats = new Set(allowedChatIds)
    this.users = new Set(allowedUserIds)
  }

  /**
   * Decide one update. Unidentifiable updates (no chat or no sender) drop.
   * @param update - The raw update; only ids are read, never content.
   * @returns the decision with a log-safe reason.
   */
  allow(update: Update): AuthzDecision {
    const chatId = chatIdOf(update)
    if (chatId === undefined) return { allowed: false, reason: 'update carries no chat id' }
    const userId = userIdOf(update)
    if (userId === undefined) return { allowed: false, reason: `update from chat ${chatId} carries no sender id` }
    if (this.chats.size > 0 && !this.chats.has(chatId)) {
      return { allowed: false, reason: `chat ${chatId} is not allowlisted` }
    }
    if (this.users.size > 0 && !this.users.has(userId)) {
      return { allowed: false, reason: `user ${userId} is not allowlisted` }
    }
    return { allowed: true, reason: 'allowed' }
  }
}
