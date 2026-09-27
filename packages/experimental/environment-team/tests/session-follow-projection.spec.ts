/** Follow presentation reconstructs only text and repairs sequence/lifecycle discontinuities. */
import { expect, it } from 'vitest'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { EnvironmentSessionFollowProjection } from '../src/session-follow.ts'

const attemptId = LlmAttemptId('active-attempt')
const opening = (): Extract<SessionFollowFrame, { type: 'snapshot' }> => ({
  type: 'snapshot', header: { version: 1, id: SessionId('follow-test'), createdAt: 0, isSeeded: false },
  cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} },
  assistantStream: { revision: 5, activeAttempt: {
    attemptId, turn: 2, step: 3, startedAfterSeq: -1, nextIndex: 4,
    stream: [
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['hel', 'lo'] },
      { type: 'reasoning-chunks', time0: 1, index: 1, dt: [], texts: ['reasoning secret'] },
      { type: 'tool-call-chunks', time0: 1, index: 2, dt: [], id: 'secret-tool', args: ['secret arguments'] },
      { type: 'chunk', time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello final' } } },
    ],
  } },
})

it('reconstructs text block finalization without exposing reasoning/tool content or settling another attempt', () => {
  const fold = new EnvironmentSessionFollowProjection(2)
  const first = fold.accept(opening(), true)
  expect(first.live).toEqual({ attemptId, text: 'hello final' })
  expect(JSON.stringify(first)).not.toContain('secret')
  const previous = fold.accept({ type: 'event', event: { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 1, step: 3 } } }, true)
  expect(previous.live).toEqual(first.live)
  const settled = fold.accept({ type: 'event', event: { type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append', data: {
    turn: 2, step: 3, message: { source: { kind: 'model' }, content: [{ type: 'text', text: 'hello final' }, { type: 'tool-call', arguments: 'secret' }] },
  } } }, true)
  expect(settled.live).toBeUndefined()
  expect(settled.messages).toEqual([{ seq: 1, role: 'assistant', text: 'hello final' }])
  expect(fold.accept({ type: 'assistant-stream', frame: { type: 'end', attemptId, revision: 6, index: 4, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } }, true).live).toBeUndefined()
})

it('requests a fresh baseline for durable gaps, revision resets and missing chunks', () => {
  const fold = new EnvironmentSessionFollowProjection(2)
  fold.accept(opening(), true)
  expect(() => fold.accept({ type: 'event', event: { type: 'turn/start', seq: 4, time: 0, data: {} } }, true)).toThrow('durable event')
  expect(() => fold.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1, startedAfterSeq: -1, turn: 1, step: 1 } }, true)).toThrow('assistant baseline')
  expect(() => fold.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId, revision: 6, index: 8, time: 0, chunk: { type: 'text-delta', index: 0, text: 'gap' } } }, true)).toThrow('chunk baseline')
})

it('bounds saved messages and ignores context/replacements while clearing abandoned live text', () => {
  const fold = new EnvironmentSessionFollowProjection(1)
  const baseline: Extract<SessionFollowFrame, { type: 'snapshot' }> = { ...opening(), records: [
    { type: 'event', event: { type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } } },
    { type: 'event', event: { type: 'user/message', seq: 1, time: 0, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'latest' }] } } },
    { type: 'event', event: { type: 'user/message', seq: 2, time: 0, surfaceOp: 'append', data: { source: { kind: 'context' }, content: [{ type: 'text', text: 'hidden context' }] } } },
    { type: 'event', event: { type: 'user/message', seq: 3, time: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, data: {} } },
    { type: 'event', event: { type: 'user/message', seq: 4, time: 0, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [] } } },
  ] }
  const view = fold.accept(baseline, true)
  expect(view.messages).toEqual([{ seq: 1, role: 'user', text: 'latest' }])
  expect(view.truncated).toBe(true)
  expect(fold.accept({ type: 'assistant-stream', frame: { type: 'end', attemptId, revision: 6, index: 4, outcome: { kind: 'abandoned' } } }, true).live).toBeUndefined()
  expect(fold.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId, revision: 7, index: 5, time: 0, chunk: { type: 'text-delta', index: 0, text: 'unknown suffix' } } }, true).live).toBeUndefined()
})

it('requires the opted-in assistant baseline before presenting the stream', () => {
  const { assistantStream: _baseline, ...snapshot } = opening()
  expect(() => new EnvironmentSessionFollowProjection(1).accept(snapshot, false)).toThrow('baseline')
})
