/** Held real model output verifies destination-owned transient text and reconnect settlement. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { EnvironmentId } from '../src/protocol.ts'
import { EnvironmentSessions } from '../src/session-service.ts'
import type { EnvironmentSessionFrame } from '../src/session-types.ts'
import { sessionHost } from './session-host.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function until(iterator: AsyncIterator<EnvironmentSessionFrame>, accept: (frame: EnvironmentSessionFrame) => boolean) {
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new Error('follow ended before the expected frame')
    if (accept(next.value)) return next.value
  }
}

it('reconnects to active text and settles once while disconnect leaves destination generation running', async () => {
  const host = await sessionHost()
  cleanup.push(host.close)
  const release = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  let generation: GenerateOptions | undefined
  vi.spyOn(host.adapter, 'stream').mockImplementation(async function* (options) {
    generation = options
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield { type: 'reasoning-delta', index: 1, text: 'private reasoning' }
    entered.resolve(undefined)
    await release.promise
    yield { type: 'text-delta', index: 0, text: ' complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial complete' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const executor = new EnvironmentSessions(host.ctx, host.id, host.config)
  const sessionId = SessionId(randomUUID())
  const request = { workspaceId: host.workspace.id, sessionId }
  const signal = new AbortController().signal
  await executor.run(host.id, { action: 'create', ...request }, signal)
  const firstAbort = new AbortController()
  const first = executor.follow(host.id, request, firstAbort.signal)[Symbol.asyncIterator]()
  cleanup.push(async () => { firstAbort.abort(); await first.return?.().catch(() => undefined) })
  expect((await first.next()).value).toMatchObject({ kind: 'snapshot', messages: [], running: false })
  await executor.run(host.id, { action: 'prompt', ...request, requestId: brandString<SessionRequestId>(randomUUID()), text: 'hello' }, signal)
  await entered.promise
  const live = await until(first, frame => frame.live?.text === 'partial')
  expect(JSON.stringify(live)).not.toContain('private reasoning')
  expect(live.running).toBe(true)
  const secondAbort = new AbortController()
  const second = executor.follow(host.id, request, secondAbort.signal)[Symbol.asyncIterator]()
  cleanup.push(async () => { secondAbort.abort(); await second.return?.().catch(() => undefined) })
  const openingResult = await second.next()
  if (openingResult.done) throw new Error('follow ended before its opening')
  const opening = openingResult.value
  expect(opening).toMatchObject({ live: { text: 'partial' }, running: true, messages: [{ role: 'user', text: 'hello' }] })
  expect(JSON.stringify(opening)).not.toContain('private reasoning')
  firstAbort.abort()
  await first.return?.()
  expect(generation?.signal?.aborted).toBe(false)
  expect(host.ctx.agents.get(sessionId)?.status).toBe('running')
  release.resolve(undefined)
  const settled = await until(second, frame => !frame.running && frame.messages.some(message => message.role === 'assistant'))
  expect(settled.live).toBeUndefined()
  expect(settled.messages).toEqual([expect.objectContaining({ role: 'user', text: 'hello' }), expect.objectContaining({ role: 'assistant', text: 'partial complete' })])
  await expect(JSON.stringify({ opening: { messages: opening?.messages, live: opening?.live?.text }, settled: { messages: settled.messages.map(message => ({ role: message.role, text: message.text })), running: settled.running } }, null, 2) + '\n').toMatchFileSnapshot('expected/remote-live-session.txt')
})

it('rejects unauthorized follows before activation and bounds complete frames', async () => {
  const host = await sessionHost()
  cleanup.push(host.close)
  const executor = new EnvironmentSessions(host.ctx, host.id, host.config)
  const request = { workspaceId: host.workspace.id, sessionId: SessionId(randomUUID()) }
  await executor.run(host.id, { action: 'create', ...request }, new AbortController().signal)
  await expect(executor.follow(brandString<EnvironmentId>(randomUUID()), request, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-denied' })
  host.config.maxBytes = 1
  await expect(executor.follow(host.id, request, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  const empty = new Context()
  cleanup.push(() => empty.fiber.dispose())
  await expect(new EnvironmentSessions(empty, host.id, host.config).follow(host.id, request, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-unsupported' })
})

it('rejects an opening outside the authorized workspace and distinguishes malformed baselines from retryable discontinuities', async () => {
  const host = await sessionHost()
  cleanup.push(host.close)
  const executor = new EnvironmentSessions(host.ctx, host.id, host.config)
  const request = { workspaceId: host.workspace.id, sessionId: SessionId(randomUUID()) }
  const signal = new AbortController().signal
  await executor.run(host.id, { action: 'create', ...request }, signal)
  const source = host.controller.follow({ address: { kind: 'session', sessionId: request.sessionId }, assistantStream: true }, signal)[Symbol.asyncIterator]()
  const opening = await source.next()
  await source.return?.()
  if (opening.done || opening.value.type !== 'snapshot') throw new Error('expected opening snapshot')
  const baseline = opening.value
  const following = vi.spyOn(host.controller, 'follow')
  following.mockImplementation(async function* () { yield { ...baseline, header: { ...baseline.header, cwd: host.root } } })
  await expect(executor.follow(host.id, request, signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-denied' })
  const { assistantStream: _baseline, ...withoutAssistant } = baseline
  following.mockImplementation(async function* () { yield withoutAssistant })
  await expect(executor.follow(host.id, request, signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  following.mockImplementation(async function* () { yield baseline; yield { type: 'event', event: { type: 'turn/start', seq: baseline.cursor + 2, time: 0, data: {} } } })
  const stream = executor.follow(host.id, request, signal)[Symbol.asyncIterator]()
  await stream.next()
  await expect(stream.next()).rejects.toMatchObject({ code: 'environment/session-unavailable' })
})
