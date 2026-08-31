/**
 * Minimal Telegram Bot API transport over `fetch`: long-poll updates plus the
 * outbound call set the plugin needs, with per-operation token resolution,
 * bounded retries, and global send pacing. The interface is the seam tests
 * fake; production uses `HttpTelegramApi`.
 * @module @deepseek-ai/dsh-telegram/src/bot
 */

import type {
  ChatTarget,
  CreatedForumTopic,
  InlineKeyboard,
  ParseMode,
  SentMessage,
  TelegramFile,
  Update,
} from './types.ts'

/** Bot API error facts: `ok: false` response or a transport-level failure. */
export class TelegramApiError extends Error {
  /**
   * @param message - Human-readable failure.
   * @param code - Bot API `error_code` when the API answered; `undefined` for network-level failures.
   * @param retryAfterMs - Bot API `retry_after` hint when the failure was a 429.
   */
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

/** Sending into a closed forum topic: the Bot API answers 400 with this description. */
const CLOSED_TOPIC = 'message thread is closed'

/**
 * Whether an error means the addressed topic accepts no posts right now.
 * @param error - The value a Bot API call rejected with; non-error values classify as `false`.
 * @returns `true` for a {@link TelegramApiError} carrying Bot API code 400 with the closed-thread description.
 */
export function isClosedTopic(error: unknown): boolean {
  return error instanceof TelegramApiError && error.code === 400 && error.message.includes(CLOSED_TOPIC)
}

/** Retryable failure classes: throttling, server faults, and transport flakiness. */
function isRetryable(error: TelegramApiError): boolean {
  return error.code === 429 || error.code === undefined || error.code >= 500
}

/** Delay that rejects when the signal aborts; function-call indirection keeps control-flow narrowing out of the caller. */
async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal !== undefined && signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }, { once: true })
  })
}

/** Outbound send options shared by message-like calls. */
export interface SendOptions {
  /** Bot API parse mode for the message text; omitted sends the text unparsed. */
  readonly parseMode?: ParseMode
  /** Inline keyboard rows to attach; omitted posts the message without buttons. */
  readonly replyMarkup?: InlineKeyboard
}

/** Photo/document caption options. */
export interface MediaOptions {
  /** Caption posted alongside the media; omitted posts the file with no caption. */
  readonly caption?: string
  /** Bot API parse mode for the caption; omitted sends the caption unparsed. */
  readonly parseMode?: ParseMode
}

/**
 * The Telegram wire surface the plugin drives. Implementations must resolve
 * the credential per call (the token never rides config text) and surface Bot
 * API failures as {@link TelegramApiError}.
 */
export interface TelegramApi {
  /**
   * Long-poll one batch; resolves with possibly-empty updates. `offset` is
   * the `update_id + 1` confirmation; `timeoutSeconds` is the Bot API
   * long-poll wait bound.
   */
  getUpdates(offset: number | undefined, signal: AbortSignal, timeoutSeconds: number): Promise<Update[]>
  /** Post one text message in a topic (thread omitted for the General topic). */
  sendMessage(target: ChatTarget, text: string, options?: SendOptions): Promise<SentMessage>
  /** Edit one posted message's text in place. */
  editMessageText(target: ChatTarget, messageId: number, text: string, options?: SendOptions): Promise<SentMessage>
  /** Delete one posted message. */
  deleteMessage(target: ChatTarget, messageId: number): Promise<void>
  /** Post one photo from raw bytes. */
  sendPhoto(target: ChatTarget, data: Uint8Array, options?: MediaOptions): Promise<SentMessage>
  /** Post one document from raw bytes. */
  sendDocument(target: ChatTarget, data: Uint8Array, filename: string, options?: MediaOptions): Promise<SentMessage>
  /** Create one forum topic in a topics-enabled supergroup; the bot needs the `can_manage_topics` right there. */
  createForumTopic(chatId: number, name: string): Promise<CreatedForumTopic>
  /** Acknowledge one callback button press. */
  answerCallbackQuery(callbackId: string, options?: { readonly text?: string }): Promise<void>
  /** Remove one posted message's inline keyboard. */
  removeInlineKeyboard(target: ChatTarget, messageId: number): Promise<SentMessage>
  /** Replace one posted message's inline keyboard in place. */
  editInlineKeyboard(target: ChatTarget, messageId: number, replyMarkup: InlineKeyboard): Promise<SentMessage>
  /** Resolve a file reference to its download path. */
  getFile(fileId: string): Promise<TelegramFile>
  /** Download one file by `getFile`'s `file_path`. */
  downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array>
}

/** Outbound text message payload. */
interface SendMessagePayload {
  readonly chat_id: number
  readonly message_thread_id?: number
  readonly text: string
  readonly parse_mode?: ParseMode
  readonly reply_markup?: { readonly inline_keyboard: InlineKeyboard }
}

/** Callback acknowledgement payload. */
interface AnswerCallbackPayload {
  readonly callback_query_id: string
  readonly text?: string
}

/** Photo/document payload. */
interface MediaPayload {
  readonly chat_id: number
  readonly message_thread_id?: number
  readonly caption?: string
  readonly parse_mode?: ParseMode
}

/** Global send pacing: at most one API call per slot, amortized across every topic. */
class SendPacer {
  private nextSlotAt = 0

  constructor(private readonly minIntervalMs: number) {}

  /** Wait until this call's slot opens. */
  async wait(): Promise<void> {
    const now = Date.now()
    const waitMs = Math.max(0, this.nextSlotAt - now)
    this.nextSlotAt = now + waitMs + this.minIntervalMs
    if (waitMs > 0) await new Promise<void>(resolve => setTimeout(resolve, waitMs))
  }
}

/**
 * Production Bot API client. The token resolves through the supplied resolver
 * before every HTTP call, so a rotated credential reaches the next operation
 * without a reload. Retries cover 429 (honoring `retry_after`) and 5xx/network
 * failures; 400-family answers surface immediately as
 * {@link TelegramApiError}.
 */
export class HttpTelegramApi implements TelegramApi {
  private readonly pacer: SendPacer

  /**
   * @param resolveToken - Per-call credential resolution (typically `ctx.credentials.resolve`).
   * @param apiBase - Bot API base URL without a trailing slash.
   * @param retryBaseDelayMs - Backoff start; doubles per attempt.
   */
  constructor(
    private readonly resolveToken: () => Promise<string>,
    private readonly apiBase = 'https://api.telegram.org',
    private readonly retryBaseDelayMs = 250,
  ) {
    this.pacer = new SendPacer(34)
  }

  async getUpdates(offset: number | undefined, signal: AbortSignal, timeoutSeconds: number): Promise<Update[]> {
    const payload: Record<string, unknown> = { timeout: timeoutSeconds, allowed_updates: [
      'message', 'edited_message', 'callback_query',
    ] }
    if (offset !== undefined) payload.offset = offset
    const response = await this.call('getUpdates', payload, signal, false)
    return response.result as Update[]
  }

  async sendMessage(target: ChatTarget, text: string, options?: SendOptions): Promise<SentMessage> {
    const payload: SendMessagePayload = {
      chat_id: target.chatId,
      text,
      ...target.threadId !== null ? { message_thread_id: target.threadId } : {},
      ...options?.parseMode !== undefined ? { parse_mode: options.parseMode } : {},
      ...options?.replyMarkup !== undefined ? { reply_markup: { inline_keyboard: options.replyMarkup } } : {},
    }
    return await this.send('sendMessage', payload)
  }

  async editMessageText(target: ChatTarget, messageId: number, text: string, options?: SendOptions): Promise<SentMessage> {
    const payload = {
      chat_id: target.chatId,
      message_id: messageId,
      text,
      ...target.threadId !== null ? { message_thread_id: target.threadId } : {},
      ...options?.parseMode !== undefined ? { parse_mode: options.parseMode } : {},
      ...options?.replyMarkup !== undefined ? { reply_markup: { inline_keyboard: options.replyMarkup } } : {},
    }
    return await this.send('editMessageText', payload)
  }

  async deleteMessage(target: ChatTarget, messageId: number): Promise<void> {
    await this.send('deleteMessage', { chat_id: target.chatId, message_id: messageId })
  }

  async sendPhoto(target: ChatTarget, data: Uint8Array, options?: MediaOptions): Promise<SentMessage> {
    const payload: MediaPayload = {
      chat_id: target.chatId,
      ...target.threadId !== null ? { message_thread_id: target.threadId } : {},
      ...options?.caption !== undefined ? { caption: options.caption } : {},
      ...options?.parseMode !== undefined ? { parse_mode: options.parseMode } : {},
    }
    return await this.sendMultipart('sendPhoto', 'photo', 'photo.jpg', data, payload)
  }

  async sendDocument(target: ChatTarget, data: Uint8Array, filename: string, options?: MediaOptions): Promise<SentMessage> {
    const payload: MediaPayload = {
      chat_id: target.chatId,
      ...target.threadId !== null ? { message_thread_id: target.threadId } : {},
      ...options?.caption !== undefined ? { caption: options.caption } : {},
      ...options?.parseMode !== undefined ? { parse_mode: options.parseMode } : {},
    }
    return await this.sendMultipart('sendDocument', 'document', filename, data, payload)
  }

  async createForumTopic(chatId: number, name: string): Promise<CreatedForumTopic> {
    const response = await this.call('createForumTopic', { chat_id: chatId, name }, undefined, true)
    return response.result as CreatedForumTopic
  }

  async answerCallbackQuery(callbackId: string, options?: { readonly text?: string }): Promise<void> {
    const payload: AnswerCallbackPayload = {
      callback_query_id: callbackId,
      ...options?.text !== undefined ? { text: options.text } : {},
    }
    await this.send('answerCallbackQuery', payload)
  }

  async removeInlineKeyboard(target: ChatTarget, messageId: number): Promise<SentMessage> {
    return await this.send('editMessageReplyMarkup', {
      chat_id: target.chatId,
      message_id: messageId,
      ...target.threadId !== null ? { message_thread_id: target.threadId } : {},
      reply_markup: undefined,
    })
  }

  async editInlineKeyboard(target: ChatTarget, messageId: number, replyMarkup: InlineKeyboard): Promise<SentMessage> {
    return await this.send('editMessageReplyMarkup', {
      chat_id: target.chatId,
      message_id: messageId,
      ...target.threadId !== null ? { message_thread_id: target.threadId } : {},
      reply_markup: { inline_keyboard: replyMarkup },
    })
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    const response = await this.call('getFile', { file_id: fileId }, undefined, true)
    return response.result as TelegramFile
  }

  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    const token = await this.resolveToken()
    const response = await fetch(`${this.apiBase}/file/bot${token}/${filePath}`, {
      ...signal !== undefined ? { signal } : {},
    })
    if (!response.ok) {
      throw new TelegramApiError(`telegram file download failed: HTTP ${response.status}`, response.status, undefined)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /** One JSON API call with pacing and bounded retries. */
  private async call(
    method: string,
    payload: object,
    signal: AbortSignal | undefined,
    paced: boolean,
  ): Promise<TelegramResponse> {
    const token = await this.resolveToken()
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
    if (paced) await this.pacer.wait()
    let attempt = 0
    for (;;) {
      try {
        const response = await fetch(`${this.apiBase}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          ...signal !== undefined ? { signal } : {},
        })
        if (!response.ok) {
          throw new TelegramApiError(
            `telegram API call ${method} failed: HTTP ${response.status}`,
            response.status,
            undefined,
          )
        }
        const body = await response.json() as TelegramResponseBody
        if (body.ok !== true) {
          const retryAfterMs = body.parameters?.retry_after !== undefined ? body.parameters.retry_after * 1000 : undefined
          throw new TelegramApiError(
            `telegram API call ${method} rejected: ${body.description ?? 'unknown error'}`,
            body.error_code,
            retryAfterMs,
          )
        }
        return body as { readonly ok: true; readonly result: unknown }
      } catch (error) {
        const apiError = error instanceof TelegramApiError ? error : new TelegramApiError(String(error), undefined, undefined)
        if (!isRetryable(apiError) || attempt >= 2) throw apiError
        attempt += 1
        const backoff = Math.max(apiError.retryAfterMs ?? 0, this.retryBaseDelayMs * 2 ** (attempt - 1))
        await abortableDelay(backoff, signal)
      }
    }
  }

  /** One paced JSON call. */
  private async send(method: string, payload: object): Promise<SentMessage> {
    const response = await this.call(method, payload, undefined, true)
    return response.result as SentMessage
  }

  /** One paced multipart call. */
  private async sendMultipart(
    method: string,
    field: 'photo' | 'document',
    filename: string,
    data: Uint8Array,
    payload: MediaPayload,
  ): Promise<SentMessage> {
    const token = await this.resolveToken()
    await this.pacer.wait()
    const form = new FormData()
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) form.append(key, String(value))
    }
    form.append(field, new Blob([data as unknown as BlobPart]), filename)
    const response = await fetch(`${this.apiBase}/bot${token}/${method}`, { method: 'POST', body: form })
    if (!response.ok) {
      throw new TelegramApiError(`telegram API call ${method} failed: HTTP ${response.status}`, response.status, undefined)
    }
    const body = await response.json() as TelegramResponseBody
    if (body.ok !== true) {
      const retryAfterMs = body.parameters?.retry_after !== undefined ? body.parameters.retry_after * 1000 : undefined
      throw new TelegramApiError(
        `telegram API call ${method} rejected: ${body.description ?? 'unknown error'}`,
        body.error_code,
        retryAfterMs,
      )
    }
    return (body as { readonly ok: true; readonly result: SentMessage }).result
  }
}

/** An error-answer body; `ok: true` responses carry `result` instead. */
interface TelegramResponseBody {
  readonly ok?: boolean
  readonly error_code?: number
  readonly description?: string
  readonly parameters?: { readonly retry_after?: number }
}

/** An accepted JSON answer, untyped until the caller narrows `result`. */
interface TelegramResponse {
  readonly ok: true
  readonly result: unknown
}
