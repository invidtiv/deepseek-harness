import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTelegramApi, isClosedTopic, TelegramApiError } from '../src/bot.ts'
import type { ChatTarget, InlineKeyboard } from '../src/types.ts'

/** One recorded outbound HTTP request. */
interface RecordedRequest {
  readonly url: string
  readonly body: unknown
  readonly signal: AbortSignal | undefined
}

/** Bot API answer for an accepted call. */
function accepted(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Bot API answer carrying `ok: false` under HTTP 200. */
function rejected(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** Transport-level HTTP failure with no Bot API body. */
function httpStatus(status: number): Response {
  return new Response('failure', { status })
}

/** Install a scripted `fetch` and collect every request the client makes. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url: String(input), body: init.body, signal: init.signal ?? undefined })
    return await handler(String(input), init)
  })
  return requests
}

/** Answer the first script entry per call, repeating the last one afterwards. */
function stubSequence(script: Array<() => Response | Promise<Response>>): RecordedRequest[] {
  let index = 0
  return stubFetch(async () => {
    const entry = script[Math.min(index, script.length - 1)] as () => Response | Promise<Response>
    index += 1
    return await entry()
  })
}

function jsonBody(request: RecordedRequest | undefined): Record<string, unknown> {
  if (typeof request?.body !== 'string') throw new Error('expected a JSON request body')
  return JSON.parse(request.body) as Record<string, unknown>
}

function formBody(request: RecordedRequest | undefined): FormData {
  if (!(request?.body instanceof FormData)) throw new Error('expected a multipart request body')
  return request.body
}

const TOKEN = async (): Promise<string> => 'T'
const GENERAL: ChatTarget = { chatId: 11, threadId: null }
const TOPIC: ChatTarget = { chatId: 11, threadId: 5 }
const KEYBOARD: InlineKeyboard = [[{ text: 'Allow', callback_data: 'a' }]]

/** Client with instant backoff so retry paths stay fast. */
function client(base = 'http://bot.test'): HttpTelegramApi {
  return new HttpTelegramApi(TOKEN, base, 1)
}

describe('HttpTelegramApi outbound calls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts text messages with the thread id, parse mode, and keyboard, paced across calls', async () => {
    const requests = stubFetch(() => accepted({ message_id: 9, chat: { id: 11 } }))
    const api = client()
    const started = Date.now()
    const first = await api.sendMessage(GENERAL, 'plain')
    await api.sendMessage(TOPIC, 'rich', { parseMode: 'HTML', replyMarkup: KEYBOARD })
    // The second call waits for its pacing slot instead of posting immediately.
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(first.message_id).toBe(9)
    expect(requests[0]?.url).toBe('http://bot.test/botT/sendMessage')
    expect(jsonBody(requests[0])).toEqual({ chat_id: 11, text: 'plain' })
    expect(jsonBody(requests[1])).toEqual({
      chat_id: 11,
      message_thread_id: 5,
      text: 'rich',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: KEYBOARD },
    })
  })

  it('edits message text with and without options', async () => {
    const requests = stubFetch(() => accepted({ message_id: 4, chat: { id: 11 } }))
    const api = client()
    await api.editMessageText(GENERAL, 4, 'plain')
    await api.editMessageText(TOPIC, 4, 'rich', { parseMode: 'MarkdownV2', replyMarkup: KEYBOARD })
    expect(jsonBody(requests[0])).toEqual({ chat_id: 11, message_id: 4, text: 'plain' })
    expect(jsonBody(requests[1])).toEqual({
      chat_id: 11,
      message_id: 4,
      message_thread_id: 5,
      text: 'rich',
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: KEYBOARD },
    })
  })

  it('deletes a message and acknowledges callbacks with and without a note', async () => {
    const requests = stubFetch(() => accepted(true))
    const api = client()
    await api.deleteMessage(GENERAL, 7)
    await api.answerCallbackQuery('cb-1')
    await api.answerCallbackQuery('cb-2', { text: 'expired' })
    expect(requests[0]?.url).toBe('http://bot.test/botT/deleteMessage')
    expect(jsonBody(requests[0])).toEqual({ chat_id: 11, message_id: 7 })
    expect(jsonBody(requests[1])).toEqual({ callback_query_id: 'cb-1' })
    expect(jsonBody(requests[2])).toEqual({ callback_query_id: 'cb-2', text: 'expired' })
  })

  it('clears and replaces inline keyboards in place', async () => {
    const requests = stubFetch(() => accepted({ message_id: 3, chat: { id: 11 } }))
    const api = client()
    await api.removeInlineKeyboard(TOPIC, 3)
    await api.editInlineKeyboard(GENERAL, 3, KEYBOARD)
    await api.removeInlineKeyboard(GENERAL, 4)
    await api.editInlineKeyboard(TOPIC, 4, KEYBOARD)
    expect(requests[0]?.url).toBe('http://bot.test/botT/editMessageReplyMarkup')
    expect(jsonBody(requests[0])).toEqual({ chat_id: 11, message_id: 3, message_thread_id: 5 })
    expect(jsonBody(requests[1])).toEqual({
      chat_id: 11,
      message_id: 3,
      reply_markup: { inline_keyboard: KEYBOARD },
    })
    expect(jsonBody(requests[2])).toEqual({ chat_id: 11, message_id: 4 })
    expect(jsonBody(requests[3])).toEqual({
      chat_id: 11,
      message_id: 4,
      message_thread_id: 5,
      reply_markup: { inline_keyboard: KEYBOARD },
    })
  })

  it('creates a forum topic and returns its thread id', async () => {
    const requests = stubFetch(() => accepted({ message_thread_id: 88, name: 'proj' }))
    const api = client()
    const topic = await api.createForumTopic(11, 'proj')
    expect(topic).toEqual({ message_thread_id: 88, name: 'proj' })
    expect(requests[0]?.url).toBe('http://bot.test/botT/createForumTopic')
    expect(jsonBody(requests[0])).toEqual({ chat_id: 11, name: 'proj' })
  })

  it('long-polls with the confirmation offset only after the first batch', async () => {
    const requests = stubFetch(() => accepted([{ update_id: 12 }]))
    const api = client()
    const controller = new AbortController()
    const updates = await api.getUpdates(undefined, controller.signal, 25)
    await api.getUpdates(13, controller.signal, 25)
    expect(updates).toEqual([{ update_id: 12 }])
    expect(jsonBody(requests[0])).toEqual({ timeout: 25, allowed_updates: ['message', 'edited_message', 'callback_query'] })
    expect(jsonBody(requests[1]).offset).toBe(13)
    expect(requests[0]?.signal).toBe(controller.signal)
  })

  it('resolves a file reference and downloads its bytes with or without a signal', async () => {
    const requests = stubFetch((url) => {
      if (url.includes('/getFile')) return accepted({ file_id: 'f1', file_path: 'photos/a.jpg', file_size: 3 })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    })
    const api = client()
    const file = await api.getFile('f1')
    expect(file.file_path).toBe('photos/a.jpg')
    expect(await api.downloadFile('photos/a.jpg')).toEqual(new Uint8Array([1, 2, 3]))
    const controller = new AbortController()
    expect(await api.downloadFile('photos/a.jpg', controller.signal)).toHaveLength(3)
    expect(requests[1]?.url).toBe('http://bot.test/file/botT/photos/a.jpg')
    expect(requests[1]?.signal).toBeUndefined()
    expect(requests[2]?.signal).toBe(controller.signal)
  })

  it('rejects a failed download with its HTTP status', async () => {
    stubFetch(() => httpStatus(404))
    await expect(client().downloadFile('photos/missing.jpg')).rejects.toMatchObject({
      name: 'TelegramApiError',
      code: 404,
    })
  })

  it('uses the public Bot API base and default backoff when none are configured', async () => {
    const requests = stubFetch(() => accepted({ message_id: 1, chat: { id: 11 } }))
    await new HttpTelegramApi(TOKEN).sendMessage(GENERAL, 'hi')
    expect(requests[0]?.url).toBe('https://api.telegram.org/botT/sendMessage')
  })
})

describe('HttpTelegramApi failure handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries a throttled answer honoring retry_after', async () => {
    const requests = stubSequence([
      () => rejected({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0.01 } }),
      () => accepted({ message_id: 2, chat: { id: 11 } }),
    ])
    await expect(client().sendMessage(GENERAL, 'retry me')).resolves.toMatchObject({ message_id: 2 })
    expect(requests).toHaveLength(2)
  })

  it('retries a server fault and a transport failure', async () => {
    const requests = stubSequence([
      () => httpStatus(502),
      () => { throw new Error('socket hang up') },
      () => accepted({ message_id: 3, chat: { id: 11 } }),
    ])
    await expect(client().sendMessage(GENERAL, 'flaky')).resolves.toMatchObject({ message_id: 3 })
    expect(requests).toHaveLength(3)
  })

  it('gives up after two retries and reports the last failure', async () => {
    const requests = stubFetch(() => httpStatus(500))
    await expect(client().sendMessage(GENERAL, 'doomed')).rejects.toMatchObject({ code: 500 })
    expect(requests).toHaveLength(3)
  })

  it('reports a transport failure with no Bot API code once retries are exhausted', async () => {
    stubFetch(() => { throw new Error('dns failure') })
    const failure = await client().sendMessage(GENERAL, 'doomed').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TelegramApiError)
    expect((failure as TelegramApiError).code).toBeUndefined()
    expect((failure as TelegramApiError).message).toContain('dns failure')
  })

  it('surfaces a client-error answer immediately, with or without a description', async () => {
    const withStatus = stubFetch(() => httpStatus(400))
    await expect(client().sendMessage(GENERAL, 'bad')).rejects.toMatchObject({ code: 400 })
    expect(withStatus).toHaveLength(1)
    vi.unstubAllGlobals()
    stubFetch(() => rejected({ ok: false, error_code: 403 }))
    await expect(client().sendMessage(GENERAL, 'bad')).rejects.toThrow(/unknown error/u)
  })

  it('classifies a closed forum topic from its Bot API description', async () => {
    stubFetch(() => rejected({ ok: false, error_code: 400, description: 'Bad Request: message thread is closed' }))
    const failure = await client().sendMessage(TOPIC, 'into a closed topic').catch((error: unknown) => error)
    expect(isClosedTopic(failure)).toBe(true)
    expect(isClosedTopic(new Error('unrelated'))).toBe(false)
  })

  it('throws before calling when the poll signal is already aborted', async () => {
    const requests = stubFetch(() => accepted([]))
    const stop = new Error('stopped')
    const withError = new AbortController()
    withError.abort(stop)
    await expect(client().getUpdates(undefined, withError.signal, 25)).rejects.toBe(stop)
    const withReasonValue = new AbortController()
    withReasonValue.abort('stopped')
    await expect(client().getUpdates(undefined, withReasonValue.signal, 25)).rejects.toThrow('aborted')
    expect(requests).toHaveLength(0)
  })

  it('abandons the retry backoff when the signal aborts during the call', async () => {
    const controller = new AbortController()
    const stop = new Error('disposed')
    stubFetch(() => {
      controller.abort(stop)
      return httpStatus(500)
    })
    await expect(client().getUpdates(undefined, controller.signal, 25)).rejects.toBe(stop)
    vi.unstubAllGlobals()
    const valueReason = new AbortController()
    stubFetch(() => {
      valueReason.abort('disposed')
      return httpStatus(500)
    })
    await expect(client().getUpdates(undefined, valueReason.signal, 25)).rejects.toThrow('aborted')
  })

  it('abandons the retry backoff when the signal aborts while it waits', async () => {
    const controller = new AbortController()
    const stop = new Error('disposed later')
    stubFetch(() => {
      setTimeout(() => { controller.abort(stop) }, 5)
      return httpStatus(500)
    })
    const slow = new HttpTelegramApi(TOKEN, 'http://bot.test', 5000)
    await expect(slow.getUpdates(undefined, controller.signal, 25)).rejects.toBe(stop)
    vi.unstubAllGlobals()
    const valueReason = new AbortController()
    stubFetch(() => {
      setTimeout(() => { valueReason.abort('disposed later') }, 5)
      return httpStatus(500)
    })
    const alsoSlow = new HttpTelegramApi(TOKEN, 'http://bot.test', 5000)
    await expect(alsoSlow.getUpdates(undefined, valueReason.signal, 25)).rejects.toThrow('aborted')
  })
})

describe('HttpTelegramApi multipart uploads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts photos and documents as multipart bodies', async () => {
    const requests = stubFetch(() => accepted({ message_id: 8, chat: { id: 11 } }))
    const api = client()
    await api.sendPhoto(TOPIC, new Uint8Array([1, 2]), { caption: 'look', parseMode: 'HTML' })
    await api.sendDocument(GENERAL, new Uint8Array([3]), 'notes.txt')
    await api.sendDocument(TOPIC, new Uint8Array([3]), 'report.txt', { caption: 'read', parseMode: 'HTML' })
    const photo = formBody(requests[0])
    expect(requests[0]?.url).toBe('http://bot.test/botT/sendPhoto')
    expect(photo.get('chat_id')).toBe('11')
    expect(photo.get('message_thread_id')).toBe('5')
    expect(photo.get('caption')).toBe('look')
    expect(photo.get('parse_mode')).toBe('HTML')
    expect((photo.get('photo') as File).name).toBe('photo.jpg')
    const document = formBody(requests[1])
    expect([...document.keys()]).toEqual(['chat_id', 'document'])
    expect((document.get('document') as File).name).toBe('notes.txt')
    const captioned = formBody(requests[2])
    expect([...captioned.keys()]).toEqual(['chat_id', 'message_thread_id', 'caption', 'parse_mode', 'document'])
  })

  it('omits a payload field that carries no value', async () => {
    const requests = stubFetch(() => accepted({ message_id: 8, chat: { id: 11 } }))
    // A target without a chat id must leave the field out rather than post the
    // string "undefined" to the Bot API.
    const chatless = { threadId: null } as unknown as ChatTarget
    await client().sendPhoto(chatless, new Uint8Array([1]))
    expect([...formBody(requests[0]).keys()]).toEqual(['photo'])
  })

  it('rejects a multipart HTTP failure without retrying', async () => {
    const requests = stubFetch(() => httpStatus(413))
    await expect(client().sendPhoto(GENERAL, new Uint8Array([1]))).rejects.toMatchObject({ code: 413 })
    expect(requests).toHaveLength(1)
  })

  it('rejects a multipart body error, with and without Bot API detail', async () => {
    stubFetch(() => rejected({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }))
    const throttled = await client().sendDocument(GENERAL, new Uint8Array([1]), 'a.txt').catch((error: unknown) => error)
    expect(throttled).toBeInstanceOf(TelegramApiError)
    expect((throttled as TelegramApiError).retryAfterMs).toBe(1000)
    vi.unstubAllGlobals()
    stubFetch(() => rejected({ ok: false }))
    await expect(client().sendDocument(GENERAL, new Uint8Array([1]), 'a.txt')).rejects.toThrow(/unknown error/u)
  })
})
