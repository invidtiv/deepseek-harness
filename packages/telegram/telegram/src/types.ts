/**
 * Type-only Telegram Bot API vocabulary plus plugin-facing record types.
 *
 * The update/message shapes mirror the exact Bot API fields the plugin reads;
 * they are deliberately permissive (absent vs undefined) because the wire is
 * untrusted JSON and the plugin narrows by checks, not by assertion. This
 * module carries no runtime code.
 * @module @deepseek-ai/dsh-telegram/src/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** One Telegram chat/forum thread identity: chat id plus the forum topic id (absent in the General topic and in private chats). */
export interface TopicRef {
  /** Telegram chat id the topic belongs to. */
  readonly chatId: number
  /** `message_thread_id` of the forum topic; `null` means the General topic or a plain chat. */
  readonly threadId: number | null
}

/** Stable string key for one topic, as stored in the mapping domain. */
export type TopicKey = string

/** One user of the Bot API, as referenced by a message or callback. */
export interface TelegramUser {
  /** Telegram user id; the value `allowedUserIds` is matched against. */
  readonly id: number
  /** Whether Telegram marks the sender as a bot. */
  readonly is_bot?: boolean
  /** Display first name, absent for senders that hide it. */
  readonly first_name?: string
  /** `@`-handle without the sign, absent for users that have none. */
  readonly username?: string
}

/** One file reference in a photo set. */
export interface PhotoSize {
  /** Download reference for this size, usable with `getFile`. */
  readonly file_id: string
  /** Identifier stable across bots; usable for deduplication, not for downloading. */
  readonly file_unique_id: string
  /** Pixel width Telegram reports for this size. */
  readonly width?: number
  /** Pixel height Telegram reports for this size. */
  readonly height?: number
  /** Encoded size in bytes, when Telegram reports it. */
  readonly file_size?: number
}

/** One document attachment. */
export interface TelegramDocument {
  /** Download reference for the document, usable with `getFile`. */
  readonly file_id: string
  /** Identifier stable across bots; usable for deduplication, not for downloading. */
  readonly file_unique_id: string
  /** Sender-supplied filename; untrusted text the plugin sanitizes before touching disk. */
  readonly file_name?: string
  /** Sender-declared MIME type; not verified against the bytes. */
  readonly mime_type?: string
  /** Size in bytes, compared against the 20 MB Bot API download limit. */
  readonly file_size?: number
}

/** Service payload of a `forum_topic_created` message. */
export interface ForumTopicCreated {
  /** Topic title as created, recorded as mapping metadata. */
  readonly name: string
  /** Topic icon color as an RGB integer. */
  readonly icon_color?: number
  /** Custom-emoji id used as the topic icon, when one was chosen. */
  readonly icon_custom_emoji_id?: string
}

/** `createForumTopic` result, narrowed to the fields the plugin stores and addresses. */
export interface CreatedForumTopic {
  /** Thread id of the created topic; posts into it carry this as `message_thread_id`. */
  readonly message_thread_id: number
  /** Topic title as the Bot API recorded it. */
  readonly name: string
}

/** Service payload of a `forum_topic_closed` message: its presence is the whole signal that the topic accepts no posts. */
export interface ForumTopicClosed {
  /* empty in the Bot API */
}

/** Service payload of a `forum_topic_reopened` message: its presence is the whole signal that the topic accepts posts again. */
export interface ForumTopicReopened {
  /* empty in the Bot API */
}

/** One inbound message. Only the fields the plugin consumes are declared. */
export interface TelegramMessage {
  /** Per-chat message id, used to address edits and deletions. */
  readonly message_id: number
  /** Forum topic the message was posted in; absent in the General topic and in plain chats. */
  readonly message_thread_id?: number
  /** Sender, absent for channel and anonymous posts. */
  readonly from?: TelegramUser
  /** Chat the message was posted in; its id is the routing carrier the authorization gate reads. */
  readonly chat: {
    /** Telegram chat id; the value `allowedChatIds` is matched against. */
    readonly id: number
    /** Chat kind Telegram reports, such as `private`, `group`, or `supergroup`. */
    readonly type?: string
    /** Whether the supergroup has forum topics enabled. */
    readonly is_forum?: boolean
  }
  /** Message text; commands arrive here, and empty or absent text is ignored. */
  readonly text?: string
  /** Caption attached to a photo or document message. */
  readonly caption?: string
  /** Photo sizes of one image, ascending; the plugin ingests the largest. */
  readonly photo?: readonly PhotoSize[]
  /** Document attachment, downloaded into the topic workspace's inbox directory. */
  readonly document?: TelegramDocument
  /** Present on the topic-creation service message; carries the title, never model input. */
  readonly forum_topic_created?: ForumTopicCreated
  /** Present on the topic-closed service message; posting pauses while the topic stays mapped. */
  readonly forum_topic_closed?: ForumTopicClosed
  /** Present on the topic-reopened service message; posting resumes. */
  readonly forum_topic_reopened?: ForumTopicReopened
}

/** One callback button press. */
export interface CallbackQuery {
  /** Callback id the bot must acknowledge, whether or not the press is acted on. */
  readonly id: string
  /** User who pressed the button. */
  readonly from: TelegramUser
  /** Message carrying the pressed keyboard; absent for presses on messages too old for Telegram to include. */
  readonly message?: {
    /** Message id of the prompt, matched against the pending prompt's own id. */
    readonly message_id: number
    /** Chat the prompt lives in; checked against the pending prompt's target before settling. */
    readonly chat: {
      /** Telegram chat id of the prompt. */
      readonly id: number
    }
    /** Forum topic of the prompt; absent in the General topic and in plain chats. */
    readonly message_thread_id?: number
  }
  /** Button payload the bot encoded; unknown or stale values are acknowledged and ignored. */
  readonly data?: string
}

/** One update from `getUpdates`, narrowed to the kinds the plugin handles. */
export interface Update {
  /** Monotonic update id; `update_id + 1` is the offset that confirms it. */
  readonly update_id: number
  /** A new message. */
  readonly message?: TelegramMessage
  /** An edited message; the poll requests the kind, and the plugin admits no edit as model input. */
  readonly edited_message?: TelegramMessage
  /** An inline-keyboard press routed to the interaction bridge. */
  readonly callback_query?: CallbackQuery
}

/** Outbound keyboard button. */
export interface InlineButton {
  /** Button label; Telegram's limit is 64 characters, so longer labels are truncated before the row is built. */
  readonly text: string
  /** Payload echoed back in the callback query; the plugin's prompt id and choice. */
  readonly callback_data: string
}

/** Outbound inline keyboard: one array per button row, in display order. */
export type InlineKeyboard = readonly InlineButton[][]

/** Chat target for outbound calls: the thread id is omitted for the General topic (posting `message_thread_id: 1` is rejected). */
export interface ChatTarget {
  /** Telegram chat id to post into. */
  readonly chatId: number
  /** Forum topic to post into; `null` posts into the General topic or a plain chat. */
  readonly threadId: number | null
}

/** Parsing modes the Bot API accepts. */
export type ParseMode = 'HTML' | 'MarkdownV2'

/** A message the Bot API reported as sent. */
export interface SentMessage {
  /** Message id of the sent message, used to edit or delete it later. */
  readonly message_id: number
  /** Chat the message landed in. */
  readonly chat: {
    /** Telegram chat id of the sent message. */
    readonly id: number
  }
}

/** Minimal `getFile` result. */
export interface TelegramFile {
  /** The reference the lookup was made with. */
  readonly file_id: string
  /** Path to append to the file-download URL; absent when Telegram serves no path for the file. */
  readonly file_path?: string
  /** Size in bytes, when Telegram reports it. */
  readonly file_size?: number
}

/** Per-topic pending-input accounting: our followups that have not yet been claimed by the driver. */
export interface PendingInput {
  /** Ids of submitted inbox messages still awaiting a claim or discard. */
  readonly messageIds: ReadonlySet<string>
  /** Count of those ids; the value the configured queue cap is compared against. */
  readonly count: number
}

/** Snapshot handed to `/status`. */
export interface TopicStatus {
  /** Topic key the snapshot describes. */
  readonly key: TopicKey
  /** Current session, or `null` before the topic's first session exists. */
  readonly sessionId: SessionId | null
  /** Generation counter, bumped by every `/reset`. */
  readonly generation: number
  /** Canonical workspace of the current session, or `null` when none is selected. */
  readonly workspace: string | null
  /** Canonical workspace `/folder` selected for the next session, or `null` when none is queued. */
  readonly pendingWorkspace: string | null
  /** Topic title recorded from the creation service message, `undefined` when never seen. */
  readonly topicTitle: string | undefined
  /** ISO timestamp of the mapping row's creation. */
  readonly createdAt: string
  /** ISO timestamp of the last admitted activity in the topic. */
  readonly lastActivity: string
  /** Coarse agent state of the topic; `cold` means the mapping row exists with no live agent handle. */
  readonly agentStatus: 'live' | 'running' | 'idle' | 'cold'
  /** Followups submitted but not yet claimed by the driver. */
  readonly queued: number
}
