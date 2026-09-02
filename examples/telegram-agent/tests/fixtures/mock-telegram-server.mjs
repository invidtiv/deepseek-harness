/**
 * Minimal in-process Bot API mock for the keyless smoke: long-polling
 * getUpdates with a push queue, message-id bookkeeping, and recorded outbound
 * text. Only the methods the plugin exercises in the smoke are implemented.
 */

import { createServer } from 'node:http'

const TOKEN = 'test-token'
const LONG_POLL_CAP_MS = 5000

export class MockTelegramServer {
  sentTexts = []
  #seen = undefined
  #pending = []
  #waiters = []
  #server = undefined
  #messageSeq = 0
  #firstPoll = undefined
  #firstPollResolve = undefined

  /** Start listening on an ephemeral port. */
  static async start() {
    const mock = new MockTelegramServer()
    await mock.#listen()
    return mock
  }

  get url() {
    const address = this.#server.address()
    if (address === null || typeof address === 'string') throw new Error('mock server not listening')
    return `http://127.0.0.1:${address.port}`
  }

  /** Resolves once the bot issues its first getUpdates long-poll. */
  waitForFirstPoll() {
    return this.#firstPoll ?? Promise.resolve()
  }

  /** Queue one update for the next getUpdates batch. */
  pushUpdate(update) {
    this.#pending.push(update)
    for (const wake of this.#waiters.splice(0)) wake()
  }

  /** Text of every sendMessage the bot posted, oldest first. */
  texts() {
    return [...this.sentTexts]
  }

  /** Every request path received, for diagnostics. */
  seenPaths() {
    return [...(this.#seen ?? [])]
  }

  async close() {
    await new Promise(resolve => this.#server.close(resolve))
  }

  async #listen() {
    this.#firstPoll = new Promise(resolve => {
      this.#firstPollResolve = resolve
    })
    this.#server = createServer((request, response) => {
      void this.#handle(request, response)
    })
    await new Promise(resolve => this.#server.listen(0, '127.0.0.1', resolve))
  }

  async #handle(request, response) {
    this.#firstPollResolve?.()
    this.#seen ??= []
    this.#seen.push(request.url)
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const match = /^\/bot([^/]+)\/([a-zA-Z]+)$/u.exec(url.pathname)
    if (match === null) {
      response.writeHead(404).end()
      return
    }
    if (match[1] !== TOKEN) {
      response.writeHead(401).end()
      return
    }
    const method = match[2]
    const body = await readJsonBody(request)
    switch (method) {
      case 'getUpdates': {
        this.#firstPollResolve?.()
        if (this.#pending.length === 0) {
          await new Promise((resolve) => {
            const waiter = () => {
              const at = this.#waiters.indexOf(waiter)
              if (at >= 0) this.#waiters.splice(at, 1)
              resolve()
            }
            this.#waiters.push(waiter)
            setTimeout(waiter, LONG_POLL_CAP_MS)
          })
        }
        const result = this.#pending.splice(0)
        this.json(response, { ok: true, result })
        return
      }
      case 'sendMessage': {
        this.sentTexts.push(body.text)
        this.json(response, { ok: true, result: { message_id: ++this.#messageSeq, chat: { id: body.chat_id } } })
        return
      }
      case 'editMessageText':
      case 'editMessageReplyMarkup': {
        this.json(response, { ok: true, result: { message_id: body.message_id, chat: { id: body.chat_id } } })
        return
      }
      case 'deleteMessage':
      case 'answerCallbackQuery': {
        this.json(response, { ok: true, result: true })
        return
      }
      default: {
        this.json(response, { ok: false, error_code: 404, description: `unsupported mock method ${method}` })
      }
    }
  }

  json(response, payload) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  }
}

/** Read and parse a JSON request body. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') ?? '{}'))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}
