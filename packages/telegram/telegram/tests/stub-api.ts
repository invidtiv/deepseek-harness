/** Recording Bot API stub for renderer and interaction-bridge unit tests. */

import type { TelegramApi } from '../src/bot.ts'
import type { ChatTarget, InlineKeyboard, SentMessage, TelegramFile, Update } from '../src/types.ts'

/** Transport methods the stub can be told to fail. */
export type StubMethod =
  | 'sendMessage'
  | 'editMessageText'
  | 'deleteMessage'
  | 'sendPhoto'
  | 'removeInlineKeyboard'
  | 'editInlineKeyboard'
  | 'answerCallbackQuery'
  | 'createForumTopic'

/** One recorded outbound call. */
export interface StubCall {
  readonly method: StubMethod
  readonly target: ChatTarget | undefined
  readonly text: string | undefined
  readonly messageId: number | undefined
  readonly replyMarkup: InlineKeyboard | undefined
  readonly photoBytes: number | undefined
}

/**
 * In-memory transport that records every call, hands out increasing message
 * ids, and fails a chosen method until told otherwise. `getUpdates` never
 * resolves: unit tests drive the classes under test directly.
 */
export class StubTelegramApi implements TelegramApi {
  readonly calls: StubCall[] = []
  /** Milliseconds `sendMessage` waits before answering. */
  sendDelayMs = 0
  private readonly failures = new Map<StubMethod, Error>()
  private messageSeq = 0

  /** Make every later call of one method reject with `error`. */
  failOn(method: StubMethod, error: Error): void {
    this.failures.set(method, error)
  }

  /** Stop failing one method. */
  recover(method: StubMethod): void {
    this.failures.delete(method)
  }

  /** Recorded calls of one method. */
  of(method: StubMethod): StubCall[] {
    return this.calls.filter(call => call.method === method)
  }

  /** The most recent recorded keyboard. */
  latestKeyboard(): InlineKeyboard | undefined {
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      const markup = this.calls[index]?.replyMarkup
      if (markup !== undefined) return markup
    }
    return undefined
  }

  getUpdates(_offset: number | undefined, signal: AbortSignal, _timeoutSeconds: number): Promise<Update[]> {
    return new Promise<Update[]>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }

  async sendMessage(
    target: ChatTarget,
    text: string,
    options?: { readonly replyMarkup?: InlineKeyboard },
  ): Promise<SentMessage> {
    if (this.sendDelayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, this.sendDelayMs))
    return this.record('sendMessage', { target, text, replyMarkup: options?.replyMarkup })
  }

  async editMessageText(target: ChatTarget, messageId: number, text: string): Promise<SentMessage> {
    return this.record('editMessageText', { target, text, messageId })
  }

  async deleteMessage(target: ChatTarget, messageId: number): Promise<void> {
    this.record('deleteMessage', { target, messageId })
  }

  async sendPhoto(target: ChatTarget, data: Uint8Array): Promise<SentMessage> {
    return this.record('sendPhoto', { target, photoBytes: data.byteLength })
  }

  async sendDocument(target: ChatTarget, _data: Uint8Array, filename: string): Promise<SentMessage> {
    return this.record('sendPhoto', { target, text: filename })
  }

  async answerCallbackQuery(callbackId: string, options?: { readonly text?: string }): Promise<void> {
    this.record('answerCallbackQuery', { text: options?.text ?? callbackId })
  }

  async createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }> {
    const sent = this.record('createForumTopic', { target: { chatId, threadId: null }, text: name })
    return { message_thread_id: sent.message_id, name }
  }

  async removeInlineKeyboard(target: ChatTarget, messageId: number): Promise<SentMessage> {
    return this.record('removeInlineKeyboard', { target, messageId })
  }

  async editInlineKeyboard(target: ChatTarget, messageId: number, replyMarkup: InlineKeyboard): Promise<SentMessage> {
    return this.record('editInlineKeyboard', { target, messageId, replyMarkup })
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return { file_id: fileId }
  }

  async downloadFile(_filePath: string): Promise<Uint8Array> {
    return new Uint8Array()
  }

  private record(method: StubMethod, fields: {
    target?: ChatTarget | undefined
    text?: string | undefined
    messageId?: number | undefined
    replyMarkup?: InlineKeyboard | undefined
    photoBytes?: number | undefined
  }): SentMessage {
    const failure = this.failures.get(method)
    if (failure !== undefined) throw failure
    this.calls.push({
      method,
      target: fields.target,
      text: fields.text,
      messageId: fields.messageId,
      replyMarkup: fields.replyMarkup,
      photoBytes: fields.photoBytes,
    })
    this.messageSeq += 1
    return { message_id: fields.messageId ?? this.messageSeq, chat: { id: fields.target?.chatId ?? 0 } }
  }
}
