/** Ordered terminal queues stop slow viewers without retaining their source subscription. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EnvironmentTerminalFrame } from '../src/interaction-types.ts'
import { terminalFrameStream } from '../src/terminal-stream.ts'

const base: Omit<EnvironmentTerminalFrame, 'frame'> = {
  environmentId: brandString<EnvironmentTerminalFrame['environmentId']>('11111111-1111-4111-8111-111111111111'),
  workspaceId: brandString<EnvironmentTerminalFrame['workspaceId']>('workspace'),
  sessionId: brandString<EnvironmentTerminalFrame['sessionId']>('session'),
  terminalId: brandString<EnvironmentTerminalFrame['terminalId']>('terminal'),
}
const output = (sequence: number): EnvironmentTerminalFrame => ({ ...base, frame: { type: 'output', sequence, data: String(sequence) } })

it('preserves every queued output frame in order', async () => {
  const frames = [output(1), output(2), output(3)]
  const stopped = vi.fn()
  const stream = terminalFrameStream(async function* () {
    try { yield* frames } finally { stopped() }
  }, new AbortController().signal, 10000)
  await stream.done
  const received: EnvironmentTerminalFrame[] = []
  for await (const frame of stream.frames) received.push(frame)
  expect(received).toEqual(frames)
  expect(stopped).toHaveBeenCalledOnce()
})

it('ends a slow viewer when aggregate encoded output exceeds its limit', async () => {
  const first = output(1)
  const stopped = vi.fn()
  const limit = Buffer.byteLength(JSON.stringify(first))
  const stream = terminalFrameStream(async function* () {
    try { yield first; yield output(2); yield output(3) } finally { stopped() }
  }, new AbortController().signal, limit)
  await stream.done
  const iterator = stream.frames[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual(first)
  await expect(iterator.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
  expect(stopped).toHaveBeenCalledOnce()
})

it('joins a suspended source when a viewer returns before requesting its first frame', async () => {
  const stopped = vi.fn()
  const started = Promise.withResolvers<undefined>()
  const stream = terminalFrameStream(async function* (signal) {
    try {
      started.resolve(undefined)
      yield output(1)
      if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } finally { stopped() }
  }, new AbortController().signal, 1000)
  await started.promise
  await stream.frames[Symbol.asyncIterator]().return?.()
  await stream.done
  expect(stopped).toHaveBeenCalledOnce()
  expect(stream.signal.aborted).toBe(true)
})

it('wakes a waiting reader on owner cancellation and preserves source failures', async () => {
  const abort = new AbortController()
  const stream = terminalFrameStream(async function* (signal) {
    if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }, abort.signal, 1000)
  const next = stream.frames[Symbol.asyncIterator]().next()
  abort.abort()
  expect(await next).toMatchObject({ done: true })
  await stream.done
  const failed = terminalFrameStream(async function* () { yield output(1); throw new Error('source failed') }, new AbortController().signal, 1000)
  const iterator = failed.frames[Symbol.asyncIterator]()
  await iterator.next()
  await expect(iterator.next()).rejects.toThrow('source failed')
})
