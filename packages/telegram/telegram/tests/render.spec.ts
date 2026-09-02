import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { TelegramApiError } from '../src/bot.ts'
import { MAX_MESSAGE_CHARS } from '../src/config.ts'
import { chunkHtml, TopicRenderer } from '../src/render.ts'
import type { ChatTarget, TopicKey } from '../src/types.ts'
import { StubTelegramApi } from './stub-api.ts'

const KEY = '1001:general' as TopicKey
const TARGET: ChatTarget = { chatId: 1001, threadId: null }
const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:abc'),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

/** Attachment store returning fixed bytes, or failing when `data` is absent. */
function attachmentStore(data: Uint8Array | undefined): AttachmentStore {
  return {
    readImage: async (ref: ImageAttachmentRef) => {
      if (data === undefined) throw new Error(`missing attachment ${ref.attachmentId}`)
      return { ref, data }
    },
  } as unknown as AttachmentStore
}

function renderer(options: {
  api: StubTelegramApi
  attachments?: AttachmentStore
  editIntervalMs?: number
}): TopicRenderer {
  return new TopicRenderer(
    options.api,
    options.attachments,
    () => options.editIntervalMs ?? 0,
    new Context().logger,
  )
}

function toolCall(name: string): SessionEvent {
  return {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId: 'call-1', name, arguments: '{}' },
  } as unknown as SessionEvent
}

function assistantMessage(content: readonly ContentBlock[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 2,
    time: 0,
    surfaceOp: { kind: 'append' },
    data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm1', content } },
  } as unknown as SessionEvent
}

function turnEnd(reason: TurnEndReason): SessionEvent {
  return { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason } } as unknown as SessionEvent
}

/** An event kind the renderer deliberately ignores. */
function usageEvent(): SessionEvent {
  return {
    type: 'usage',
    seq: 4,
    time: 0,
    data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } },
  } as unknown as SessionEvent
}

/** Let every contained send settle so a suppressed path can be observed. */
function settled(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 20))
}

describe('TopicRenderer placeholders', () => {
  it('opens one placeholder for a running turn and leaves later status alone', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    view.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
    view.onStatus('running', KEY, TARGET)
    view.onStatus('idle', KEY, TARGET)
    await settled()
    expect(api.of('sendMessage')).toHaveLength(1)
    expect(api.of('sendMessage')[0]?.text).toBe('Working…')
  })

  it('shows tool activity in the placeholder and throttles further edits', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    view.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
    view.onEvent(toolCall('bash'), KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('editMessageText')).toHaveLength(1) })
    expect(api.of('editMessageText')[0]?.text).toBe('⚙️ bash')

    const throttled = new StubTelegramApi()
    const slow = renderer({ api: throttled, editIntervalMs: 10_000 })
    slow.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(throttled.of('sendMessage')).toHaveLength(1) })
    slow.onEvent(toolCall('bash'), KEY, TARGET)
    slow.onEvent(toolCall('read'), KEY, TARGET)
    await settled()
    expect(throttled.of('editMessageText')).toHaveLength(0)
  })

  it('ignores tool activity and turn endings without an open placeholder', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    view.onEvent(toolCall('bash'), KEY, TARGET)
    view.onEvent(turnEnd({ kind: 'completed' }), KEY, TARGET)
    view.onEvent(usageEvent(), KEY, TARGET)
    await settled()
    expect(api.calls).toHaveLength(0)
  })

  it('closes the placeholder with a one-line outcome per turn-end reason', async () => {
    const cases: Array<{ reason: TurnEndReason; line: string }> = [
      { reason: { kind: 'completed' }, line: 'Done.' },
      { reason: { kind: 'aborted', reason: { kind: 'user' } }, line: 'Cancelled.' },
      { reason: { kind: 'max-tokens' }, line: 'Stopped: output limit reached.' },
      { reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } }, line: '⚠️ UNKNOWN: boom' },
      { reason: { kind: 'interrupted' }, line: 'Stopped: interrupted' },
    ]
    for (const entry of cases) {
      const api = new StubTelegramApi()
      const view = renderer({ api })
      view.onStatus('running', KEY, TARGET)
      await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
      view.onEvent(turnEnd(entry.reason), KEY, TARGET)
      await vi.waitFor(() => { expect(api.of('editMessageText')).toHaveLength(1) })
      expect(api.of('editMessageText')[0]?.text).toBe(entry.line)
    }
  })
})

describe('TopicRenderer committed output', () => {
  it('drops the placeholder, posts text, and posts image blocks as photos', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api, attachments: attachmentStore(new Uint8Array([1, 2, 3])) })
    view.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
    view.onEvent(assistantMessage([
      { type: 'text', text: 'answer' },
      { type: 'image', attachment: REF },
      { type: 'reasoning', text: 'private' },
    ]), KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendPhoto')).toHaveLength(1) })
    expect(api.of('deleteMessage')).toHaveLength(1)
    expect(api.of('sendMessage')[1]?.text).toBe('answer')
    expect(api.of('sendPhoto')[0]?.photoBytes).toBe(3)
  })

  it('reports an unreadable attachment instead of posting a photo', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api, attachments: attachmentStore(undefined) })
    view.onEvent(assistantMessage([{ type: 'image', attachment: REF }]), KEY, TARGET)
    await settled()
    expect(api.of('sendPhoto')).toHaveLength(0)
    expect(view.isDormant(KEY)).toBe(false)
  })

  it('skips image blocks when no attachment store is mounted', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    view.onEvent(assistantMessage([{ type: 'image', attachment: REF }]), KEY, TARGET)
    await settled()
    expect(api.calls).toHaveLength(0)
  })

  it('chunks a reply longer than one Telegram message', async () => {
    const api = new StubTelegramApi()
    await renderer({ api }).reply(TARGET, 'x'.repeat(MAX_MESSAGE_CHARS + 100))
    expect(api.of('sendMessage')).toHaveLength(2)
  })
})

describe('TopicRenderer closed topics', () => {
  it('goes dormant when a send hits a closed topic and resumes on reopen', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api, attachments: attachmentStore(new Uint8Array([1])) })
    view.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
    api.failOn('editMessageText', new TelegramApiError('Bad Request: message thread is closed', 400, undefined))
    view.onEvent(toolCall('bash'), KEY, TARGET)
    await vi.waitFor(() => { expect(view.isDormant(KEY)).toBe(true) })

    // Every later send stays suppressed until the topic reopens.
    view.onStatus('running', KEY, TARGET)
    view.onEvent(toolCall('read'), KEY, TARGET)
    view.onEvent(assistantMessage([{ type: 'text', text: 'muted' }, { type: 'image', attachment: REF }]), KEY, TARGET)
    await settled()
    expect(api.of('sendMessage')).toHaveLength(1)
    expect(api.of('sendPhoto')).toHaveLength(0)
    view.noteReopened(KEY)
    expect(view.isDormant(KEY)).toBe(false)
  })

  it('keeps posting after an unrelated send failure', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    view.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
    api.failOn('deleteMessage', new Error('network glitch'))
    view.onEvent(assistantMessage([{ type: 'text', text: 'answer' }]), KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(2) })
    expect(view.isDormant(KEY)).toBe(false)
  })

  it('goes dormant when the turn-end edit hits a closed topic', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    view.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
    api.failOn('editMessageText', new TelegramApiError('Bad Request: message thread is closed', 400, undefined))
    view.onEvent(turnEnd({ kind: 'completed' }), KEY, TARGET)
    await vi.waitFor(() => { expect(view.isDormant(KEY)).toBe(true) })
  })

  it('contains a placeholder send that fails outright', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    api.failOn('sendMessage', new Error('network glitch'))
    view.onStatus('running', KEY, TARGET)
    await settled()
    expect(api.calls).toHaveLength(0)
    expect(view.isDormant(KEY)).toBe(false)
    // No placeholder was opened, so a later turn opens one once sending works.
    api.recover('sendMessage')
    view.onStatus('running', KEY, TARGET)
    await vi.waitFor(() => { expect(api.of('sendMessage')).toHaveLength(1) })
  })

  it('drops the placeholder for a topic closed before the turn started', async () => {
    const api = new StubTelegramApi()
    const view = renderer({ api })
    view.noteClosed(KEY)
    view.onStatus('running', KEY, TARGET)
    await settled()
    expect(api.calls).toHaveLength(0)
  })
})

describe('chunkHtml packing', () => {
  it('appends a fitting pre block to the current chunk', () => {
    const lead = 'a'.repeat(MAX_MESSAGE_CHARS - 100)
    const chunks = chunkHtml(`${lead}<pre>code</pre>${'b'.repeat(200)}`)
    expect(chunks[0]).toBe(`${lead}<pre>code</pre>`)
    expect(chunks).toHaveLength(2)
  })
})
