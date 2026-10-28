/** Backpressure and independent cursors for live ACP shell output. */
import { JobId, type JobEventListener, type JobOutputRead, type JobRegisteredData } from '@deepseek-ai/dsh-jobs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { AcpJobOutput } from '../src/job-output.ts'

function fixture(send: (callId: ToolCallId, text: string) => Promise<void> = async () => {}) {
  const owner = SessionId('stream-owner')
  const jobId = JobId('bash-test')
  const callId = ToolCallId('shell-call')
  let listener: JobEventListener | undefined
  let read: JobOutputRead = { chunks: [], next: 0, lossy: false }
  const queued: (() => Promise<void>)[] = []
  const readAt = vi.fn(() => read)
  const unsubscribe = vi.fn(() => { listener = undefined })
  const observer = new AcpJobOutput({
    events: { subscribe: (_filter, callback) => { listener = callback; return unsubscribe } }, readAt,
  }, owner, operation => queued.push(operation), send)
  const registration: JobRegisteredData = {
    jobId, owner, kind: 'bash', label: 'print', startedAt: 0, toolCall: { callId, rootCallId: callId },
  }
  return {
    observer, queued, registration, unsubscribe, readAt, callId,
    append(text: string, at: number) {
      read = { chunks: [{ text, at }], next: at + Buffer.byteLength(text), lossy: at > 0 }
      listener?.({ type: 'output', id: jobId, owner, total: read.next })
    },
  }
}

describe('ACP job output observation', () => {
  it('coalesces pending output to one retained ring snapshot and never consumes the model cursor', async () => {
    const sent: string[] = []
    const h = fixture(async (_id, text) => { sent.push(text) })
    h.observer.register(h.registration)
    for (let index = 0; index < 100; index++) h.append('x', index)
    expect(h.queued).toHaveLength(1)
    await h.queued.shift()?.()
    expect(sent).toEqual(['[output omitted before this chunk]\nx'])
    expect(h.readAt).toHaveBeenLastCalledWith(h.registration.jobId, 0, h.registration.owner)
    h.append('next', 100)
    await h.queued.shift()?.()
    expect(sent.at(-1)).toBe('next')
    expect(h.readAt).toHaveBeenLastCalledWith(h.registration.jobId, 100, h.registration.owner)
    h.observer.complete(h.callId)
    h.append('background', 104)
    expect(h.queued).toEqual([])
    h.observer.dispose()
  })

  it('awaits a blocked write without queuing another delivery or repeating sent bytes', async () => {
    const blocked = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const sent: string[] = []
    const h = fixture(async (_id, text) => {
      sent.push(text)
      if (sent.length === 1) { entered.resolve(undefined); await blocked.promise }
    })
    h.observer.register(h.registration)
    h.append('first', 0)
    const running = h.queued.shift()?.()
    await entered.promise
    h.append('second', 5)
    h.append('third', 11)
    expect(h.queued).toEqual([])
    h.observer.complete(h.callId)
    blocked.resolve(undefined)
    await running
    expect(sent).toEqual(['first', '[output omitted before this chunk]\nthird'])
    h.observer.dispose()
  })

  it('drops pending output on disposal while allowing the active write to settle', async () => {
    const blocked = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const sent: string[] = []
    const h = fixture(async (_id, text) => { sent.push(text); entered.resolve(undefined); await blocked.promise })
    h.observer.register(h.registration)
    h.append('first', 0)
    const running = h.queued.shift()?.()
    await entered.promise
    h.append('later', 5)
    h.observer.dispose()
    h.append('after disposal', 10)
    blocked.resolve(undefined)
    await running
    expect(sent).toEqual(['first'])
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })

  it('ignores unowned, non-shell, and copied registrations', () => {
    const h = fixture()
    h.observer.register({ ...h.registration, owner: SessionId('other') })
    h.observer.register({ ...h.registration, kind: 'workflow' })
    const { toolCall: _toolCall, ...withoutCall } = h.registration
    h.observer.register(withoutCall)
    h.append('ignored', 0)
    expect(h.queued).toEqual([])
    h.observer.dispose()
    h.observer.register(h.registration)
    expect(h.readAt).not.toHaveBeenCalled()
  })
})
