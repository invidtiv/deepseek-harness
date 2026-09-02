/**
 * Session events → Telegram output. The renderer forwards only committed
 * assistant text/images (never raw chunks or reasoning), keeps one throttled
 * status placeholder per topic, and turns turn endings into one-line
 * outcomes. Formatting and chunking helpers are pure and exported for tests.
 * @module @deepseek-ai/dsh-telegram/src/render
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { isClosedTopic } from './bot.ts'
import type { TelegramApi } from './bot.ts'
import { MAX_MESSAGE_CHARS } from './config.ts'
import type { ChatTarget, TopicKey } from './types.ts'

/**
 * Escape text for Telegram HTML mode, then wrap fenced code blocks in `<pre>`.
 * @param text - Raw assistant or command text; no markup is trusted.
 * @returns the escaped text, safe to send with `parseMode: 'HTML'`.
 */
export function formatTelegramHtml(text: string): string {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return escaped.replace(
    /```[^\n]*\n([\s\S]*?)```/gu,
    (_match, code: string) => `<pre>${code.replace(/\n$/u, '')}</pre>`,
  )
}

/**
 * Split Telegram-HTML text into chunks the Bot API accepts. Chunks prefer
 * line boundaries (a boundary newline is dropped rather than duplicated); a
 * `<pre>` block longer than the limit is split into its own wrapped messages
 * so no chunk carries an unclosed tag.
 * @param html - Already-escaped text (see {@link formatTelegramHtml}).
 * @param max - Hard character ceiling per message.
 * @returns sequential sendable chunks, each within the ceiling.
 */
export function chunkHtml(html: string, max: number = MAX_MESSAGE_CHARS): string[] {
  if (html.length <= max) return [html]
  const chunks: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.length > 0) {
      chunks.push(buffer)
      buffer = ''
    }
  }
  /** Pack one plain run by line boundaries, preserving inner newlines. */
  const packRun = (run: string): void => {
    for (const line of run.split('\n')) {
      if (line.length > max) {
        flush()
        for (let start = 0; start < line.length; start += max) {
          chunks.push(line.slice(start, start + max))
        }
        continue
      }
      if (buffer.length + 1 + line.length > max) {
        flush()
        buffer = line
      } else {
        buffer = buffer === '' ? line : `${buffer}\n${line}`
      }
    }
  }
  const packPart = (part: string): void => {
    if (buffer.length + part.length > max) {
      flush()
      buffer = part
    } else {
      buffer += part
    }
  }
  const pattern = /<pre>([\s\S]*?)<\/pre>/gu
  let last = 0
  for (const match of html.matchAll(pattern)) {
    const index = match.index
    packRun(html.slice(last, index))
    const code = match[1] as string
    const wrapped = `<pre>${code}</pre>`
    if (wrapped.length > max) {
      flush()
      const inner = max - '<pre></pre>'.length
      for (let start = 0; start < code.length; start += inner) {
        chunks.push(`<pre>${code.slice(start, start + inner)}</pre>`)
      }
    } else {
      packPart(wrapped)
    }
    last = index + match[0].length
  }
  packRun(html.slice(last))
  flush()
  return chunks
}

/** Per-topic rendering state: the placeholder message and the edit throttle. */
interface RenderState {
  placeholderId: number | undefined
  lastEditAt: number
}

/**
 * Output renderer bound to one transport. It owns the per-topic placeholder
 * lifecycle and the dormant flag for closed topics; every send is contained
 * so a Telegram failure never corrupts session state.
 */
export class TopicRenderer {
  private readonly states = new Map<TopicKey, RenderState>()
  private readonly dormant = new Set<TopicKey>()

  /**
   * @param api - The Telegram transport.
   * @param attachments - Optional attachment store for assistant image blocks.
   * @param editIntervalMs - Minimum placeholder-edit interval per topic, read per edit so a settings change applies live.
   * @param logger - Structured logger; ids only, never content.
   */
  constructor(
    private readonly api: TelegramApi,
    private readonly attachments: AttachmentStore | undefined,
    private readonly editIntervalMs: () => number,
    private readonly logger: Context['logger'],
  ) {}

  /**
   * Whether the topic currently drops sends (closed by a moderator).
   * @param key - Topic key.
   * @returns `true` while the topic is dormant; sends stay suppressed until it reopens.
   */
  isDormant(key: TopicKey): boolean {
    return this.dormant.has(key)
  }

  /**
   * Topic closed: stop posting to it, keep the session live.
   * @param key - Topic key.
   */
  noteClosed(key: TopicKey): void {
    this.dormant.add(key)
  }

  /**
   * Topic reopened: resume posting.
   * @param key - Topic key.
   */
  noteReopened(key: TopicKey): void {
    this.dormant.delete(key)
  }

  /**
   * Agent went running: open the status placeholder for its topic.
   * @param status - Agent status from `agent/status`; only `running` opens a placeholder.
   * @param key - Topic key owning the agent.
   * @param target - Chat target the placeholder is posted into.
   */
  onStatus(status: string, key: TopicKey, target: ChatTarget): void {
    if (status === 'running') void this.ensurePlaceholder(key, target)
  }

  /**
   * One session event, pre-routed by the runtime to the owning topic.
   * @param event - The session event; kinds other than tool calls, committed assistant messages, and turn
   *   endings produce no output.
   * @param key - Topic key owning the session.
   * @param target - Chat target the output is posted into.
   */
  onEvent(event: SessionEvent, key: TopicKey, target: ChatTarget): void {
    switch (event.type) {
      case 'tool/call':
        void this.editPlaceholder(key, target, `⚙️ ${event.data.name}`)
        return
      case 'assistant/message':
        void this.deliver(key, target, event.data.message.content)
        return
      case 'turn/end':
        void this.finishPlaceholder(key, target, event.data.reason)
        return
      default:
        return
    }
  }

  /**
   * Send plain text into a topic (command replies, refusals), chunked.
   * @param target - Chat target the reply is posted into.
   * @param text - Reply text; escaped and split across messages within the Bot API ceiling.
   * @returns resolution after every chunk was accepted by the Bot API.
   */
  async reply(target: ChatTarget, text: string): Promise<void> {
    for (const chunk of chunkHtml(formatTelegramHtml(text))) {
      await this.api.sendMessage(target, chunk)
    }
  }

  /** Open the one placeholder message for a running turn. */
  private async ensurePlaceholder(key: TopicKey, target: ChatTarget): Promise<void> {
    const state = this.stateOf(key)
    if (state.placeholderId !== undefined || this.dormant.has(key)) return
    try {
      const sent = await this.api.sendMessage(target, 'Working…')
      state.placeholderId = sent.message_id
      state.lastEditAt = Date.now()
    } catch (error) {
      this.containSendFailure(key, error)
    }
  }

  /** Throttled placeholder edit showing current tool activity. */
  private async editPlaceholder(key: TopicKey, target: ChatTarget, text: string): Promise<void> {
    const state = this.states.get(key)
    if (state?.placeholderId === undefined || this.dormant.has(key)) return
    const now = Date.now()
    if (now - state.lastEditAt < this.editIntervalMs()) return
    state.lastEditAt = now
    try {
      await this.api.editMessageText(target, state.placeholderId, text)
    } catch (error) {
      this.containSendFailure(key, error)
    }
  }

  /**
   * Deliver one committed assistant message: remove the placeholder, then
   * send text blocks chunked and image blocks as photos. Reasoning and tool
   * blocks stay off the wire.
   */
  private async deliver(key: TopicKey, target: ChatTarget, content: readonly ContentBlock[]): Promise<void> {
    await this.removePlaceholder(key, target)
    if (this.dormant.has(key)) return
    for (const block of content) {
      switch (block.type) {
        case 'text': {
          for (const chunk of chunkHtml(formatTelegramHtml(block.text))) {
            await this.api.sendMessage(target, chunk, { parseMode: 'HTML' })
          }
          break
        }
        case 'image':
          await this.deliverImage(key, target, block.attachment)
          break
        default:
          break
      }
    }
  }

  /** Send one assistant image block from its durable attachment bytes. */
  private async deliverImage(key: TopicKey, target: ChatTarget, ref: ImageAttachmentRef): Promise<void> {
    if (this.attachments === undefined || this.dormant.has(key)) return
    try {
      const stored = await this.attachments.readImage(ref)
      await this.api.sendPhoto(target, stored.data)
    } catch (error) {
      this.containSendFailure(key, error)
    }
  }

  /** Delete the placeholder once committed content supersedes it. */
  private async removePlaceholder(key: TopicKey, target: ChatTarget): Promise<void> {
    const state = this.states.get(key)
    if (state?.placeholderId === undefined) return
    const placeholderId = state.placeholderId
    state.placeholderId = undefined
    try {
      await this.api.deleteMessage(target, placeholderId)
    } catch (error) {
      this.containSendFailure(key, error)
    }
  }

  /** Close the placeholder with a one-line turn outcome; the message stays as the record. */
  private async finishPlaceholder(key: TopicKey, target: ChatTarget, reason: TurnEndReason): Promise<void> {
    const state = this.states.get(key)
    if (state?.placeholderId === undefined) return
    let line: string
    switch (reason.kind) {
      case 'completed':
        line = 'Done.'
        break
      case 'aborted':
        line = 'Cancelled.'
        break
      case 'max-tokens':
        line = 'Stopped: output limit reached.'
        break
      case 'error':
        line = `⚠️ ${reason.error.code}: ${reason.error.message}`
        break
      default:
        line = `Stopped: ${reason.kind}`
        break
    }
    try {
      await this.api.editMessageText(target, state.placeholderId, line)
    } catch (error) {
      this.containSendFailure(key, error)
    }
    state.placeholderId = undefined
  }

  private stateOf(key: TopicKey): RenderState {
    let state = this.states.get(key)
    if (state === undefined) {
      state = { placeholderId: undefined, lastEditAt: 0 }
      this.states.set(key, state)
    }
    return state
  }

  private containSendFailure(key: TopicKey, error: unknown): void {
    if (isClosedTopic(error)) {
      this.noteClosed(key)
      this.logger.info(`telegram: topic ${key} is closed; posting paused until it reopens`)
      return
    }
    this.logger.warn(`telegram: send failed: ${String(error)}`)
  }
}
