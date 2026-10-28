/** Bounded live tool output over the job registry's independent observation cursor. */
import type { JobId, JobOutputRead, JobRegisteredData, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

interface StreamState {
  callId: ToolCallId
  sent: number
  pending: JobOutputRead | undefined
  scheduled: boolean
}

/** Coalesces each job to one bounded ring snapshot while transport delivery is blocked. */
export class AcpJobOutput {
  private readonly streams = new Map<JobId, StreamState>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    private readonly jobs: Pick<JobRegistry, 'events' | 'readAt'>,
    private readonly owner: SessionId,
    private readonly enqueue: (deliver: () => Promise<void>) => void,
    private readonly send: (callId: ToolCallId, text: string) => Promise<void>,
  ) {
    this.unsubscribe = jobs.events.subscribe({ owner }, (event) => {
      if (event.type === 'output' && event.owner === owner) this.capture(event.id)
    })
  }

  /**
   * Observe output for a model-owned shell invocation; copied fork history is ignored.
   * @param registration - newly committed job registration.
   */
  register(registration: JobRegisteredData): void {
    if (this.disposed || registration.owner !== this.owner || registration.toolCall === undefined
      || (registration.kind !== 'bash' && registration.kind !== 'pwsh')) return
    this.streams.set(registration.jobId, {
      callId: registration.toolCall.rootCallId, sent: 0, pending: undefined, scheduled: false,
    })
    this.capture(registration.jobId)
  }

  /**
   * Stop observing after the owning tool result; queued output precedes its replacement snapshot.
   * @param callId - completed model invocation.
   */
  complete(callId: ToolCallId): void {
    for (const [id, state] of this.streams) if (state.callId === callId) this.streams.delete(id)
  }

  /** Stop admission and discard pending snapshots; the session still awaits its active transport write. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.streams.clear()
  }

  private capture(id: JobId): void {
    const state = this.streams.get(id)
    if (state === undefined) return
    state.pending = this.jobs.readAt(id, state.sent, this.owner)
    if (state.scheduled) return
    state.scheduled = true
    this.enqueue(async () => {
      try {
        while (!this.disposed && state.pending !== undefined) {
          const read = state.pending
          state.pending = undefined
          const chunks = read.chunks.filter(chunk => chunk.at + Buffer.byteLength(chunk.text) > state.sent)
          const first = chunks[0]
          const text = chunks.map(chunk => chunk.text).join('')
          const gap = first !== undefined && (first.at > state.sent || chunks.some(chunk => chunk.gapBefore))
          state.sent = read.next
          if (text !== '') await this.send(state.callId, `${gap ? '[output omitted before this chunk]\n' : ''}${text}`)
        }
      } finally {
        state.scheduled = false
      }
    })
  }
}
