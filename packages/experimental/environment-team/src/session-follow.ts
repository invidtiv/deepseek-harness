/** Bounded text presentation folded from the Session Controller's ordered follow stream. */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { EnvironmentSessionFrame, EnvironmentSessionMessage } from './session-types.ts'

const textBlock = z.object({ type: z.literal('text'), text: z.string() })
const message = z.object({ source: z.object({ kind: z.string() }), content: z.array(z.unknown()) })
const textChunk = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), index: z.number().int().nonnegative(), text: z.string() }),
  z.object({ type: z.literal('block-start'), index: z.number().int().nonnegative(), blockType: z.literal('text') }),
  z.object({ type: z.literal('block-end'), index: z.number().int().nonnegative(), block: textBlock }),
])
const textRun = z.object({ type: z.literal('text-chunks'), time0: z.number(), index: z.number().int().nonnegative(), dt: z.array(z.number()), texts: z.array(z.string()) })
const rawChunk = z.object({ type: z.literal('chunk'), chunk: z.unknown() })

/** Maintains only the configured message window and one active text attempt. */
export class EnvironmentSessionFollowProjection {
  private messages: EnvironmentSessionMessage[] = []
  private cursor = -1
  private truncated = false
  private revision = 0
  private running = false
  private active: {
    attemptId: LlmAttemptId
    turn: number
    step: number
    index: number
    blocks: BlockAssembler
    settled: boolean
  } | undefined

  /** @param maximum - maximum retained completed text messages. */
  constructor(private readonly maximum: number) {}

  /**
   * Fold one already ordered destination frame into a detached text-only view.
   * @param frame - Session Controller snapshot, durable event, or transient frame.
   * @param running - destination Agent status at the opening snapshot.
   * @returns presentation fields to combine with destination identity and running state.
   */
  accept(frame: SessionFollowFrame, running: boolean): Pick<EnvironmentSessionFrame, 'cursor' | 'messages' | 'truncated' | 'live' | 'running'> {
    if (frame.type === 'snapshot') {
      this.messages = []
      this.running = running
      this.cursor = frame.cursor
      this.truncated = frame.hasMore
      for (const record of frame.records) this.message(record.event)
      if (!frame.assistantStream) throw new Error('session follow omitted its assistant baseline')
      this.revision = frame.assistantStream.revision
      const opening = frame.assistantStream.activeAttempt
      this.active = opening ? {
        attemptId: opening.attemptId, turn: opening.turn, step: opening.step,
        index: opening.nextIndex, blocks: new BlockAssembler(), settled: false,
      } : undefined
      if (opening) {
        for (const record of opening.stream) {
          const run = textRun.safeParse(record)
          if (run.success) {
            for (const member of expandAssistantStream([run.data])) this.chunk(member.chunk)
          } else {
            const raw = rawChunk.safeParse(record)
            if (raw.success) this.chunk(raw.data.chunk)
          }
        }
      }
    } else if (frame.type === 'event') {
      if (frame.event.seq !== this.cursor + 1) throw new RemoteError('environment/session-unavailable', 'session follow skipped a durable event', {})
      this.cursor = frame.event.seq
      if (frame.event.type === 'turn/start') this.running = true
      if (frame.event.type === 'turn/end') this.running = false
      this.message(frame.event)
      if (this.active && (frame.event.type === 'assistant/message' || frame.event.type === 'assistant/attempt')) {
        const settled = z.object({ turn: z.number(), step: z.number() }).parse(frame.event.data)
        if (settled.turn === this.active.turn && settled.step === this.active.step) this.active.settled = true
      }
    } else {
      const item = frame.frame
      if (item.revision !== this.revision + 1) throw new RemoteError('environment/session-unavailable', 'session follow needs a new assistant baseline', {})
      this.revision = item.revision
      if (item.type === 'start') {
        this.active = {
          attemptId: item.attemptId, turn: item.turn, step: item.step, index: 0, blocks: new BlockAssembler(), settled: false,
        }
      } else if (this.active?.attemptId === item.attemptId) {
        if (item.index !== this.active.index) throw new RemoteError('environment/session-unavailable', 'session follow needs a new chunk baseline', {})
        if (item.type === 'chunk') { this.active.index++; this.chunk(item.chunk) }
        else this.active = undefined
      }
    }
    const text = this.active?.blocks.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n')
    return {
      cursor: this.cursor, messages: [...this.messages], truncated: this.truncated, running: this.running,
      ...(this.active && !this.active.settled && text ? { live: { attemptId: this.active.attemptId, text } } : {}),
    }
  }

  private chunk(value: unknown): void {
    const parsed = textChunk.safeParse(value)
    if (parsed.success) this.active?.blocks.push(parsed.data)
  }

  private message(event: SessionWireEvent): void {
    if (event.surfaceOp !== 'append' || (event.type !== 'user/message' && event.type !== 'assistant/message')) return
    const value = event.type === 'assistant/message' ? z.object({ message }).parse(event.data).message : message.parse(event.data)
    if (event.type === 'user/message' && value.source.kind !== 'user') return
    const text = value.content.flatMap((block) => { const parsed = textBlock.safeParse(block); return parsed.success ? [parsed.data.text] : [] }).join('\n')
    if (!text) return
    this.messages.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text })
    if (this.messages.length > this.maximum) { this.messages.shift(); this.truncated = true }
  }
}
