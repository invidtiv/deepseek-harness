/** Replacement buffering and producer cleanup independent of consumer progress. */
import { expect, it } from 'vitest'
import { sessionFrameStream } from '../src/session-stream.ts'
import { environmentSessionFrameSchema } from '../src/session-protocol.ts'

const frame = environmentSessionFrameSchema.parse({ kind: 'snapshot', environmentId: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace', sessionId: 'session', cursor: -1, running: false, messages: [], truncated: false })

it('keeps only the newest pending replacement and still drains a completed producer', async () => {
  const stream = sessionFrameStream(async function* () {
    yield frame
    yield { ...frame, cursor: 1 }
    yield { ...frame, cursor: 2 }
  }, new AbortController().signal)
  await stream.done
  const iterator = stream.frames[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toMatchObject({ cursor: 2 })
  expect((await iterator.next()).done).toBe(true)
})

it('delivers a producer failure after its last pending snapshot', async () => {
  const failure = new Error('source failed')
  const stream = sessionFrameStream(async function* () { yield frame; throw failure }, new AbortController().signal)
  await stream.done
  const iterator = stream.frames[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual(frame)
  await expect(iterator.next()).rejects.toBe(failure)
})

it('normalizes a source rejection that has no Error object', async () => {
  const stream = sessionFrameStream(async function* () {
    yield frame
    throw undefined
  }, new AbortController().signal)
  await stream.done
  const iterator = stream.frames[Symbol.asyncIterator]()
  await iterator.next()
  await expect(iterator.next()).rejects.toThrow('Session stream failed')
})

it('joins an eager source when a consumer returns before its first pull', async () => {
  let stopped = false
  const stream = sessionFrameStream(async function* (signal) {
    try {
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield frame
    } finally { stopped = true }
  }, new AbortController().signal)
  await stream.frames[Symbol.asyncIterator]().return?.()
  expect(stopped).toBe(true)
  expect(stream.signal.aborted).toBe(true)
})

it('does not open a pre-cancelled source and wakes an idle consumer when its owner stops', async () => {
  const abort = new AbortController()
  abort.abort()
  const unopened = sessionFrameStream(async function* () { throw new Error('must not open'); yield frame }, abort.signal)
  expect((await unopened.frames[Symbol.asyncIterator]().next()).done).toBe(true)
  const owner = new AbortController()
  const idle = sessionFrameStream(async function* (signal) {
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    signal.throwIfAborted()
    yield frame
  }, owner.signal)
  const pending = idle.frames[Symbol.asyncIterator]().next()
  owner.abort()
  expect((await pending).done).toBe(true)
  await idle.done
})
