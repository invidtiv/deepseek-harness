/** Ordered terminal output with a bounded viewer queue and independently joinable teardown. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { EnvironmentTerminalFrame } from './interaction-types.ts'
import { streamWake } from './stream-wake.ts'

/** A single viewer's terminal stream; ending it never stops the terminal process. */
export interface TerminalFrameStream {
  readonly signal: AbortSignal
  readonly frames: AsyncIterable<EnvironmentTerminalFrame>
  readonly done: Promise<void>
}

/** Drain a terminal subscription while bounding all queued frames by their encoded bytes.
 * @param open - destination terminal subscription factory.
 * @param signal - viewer or runtime cancellation.
 * @param maxBytes - maximum complete frame and aggregate queued frame size.
 * @returns ordered frames and independently joinable source teardown; overflow requires a fresh screen baseline.
 */
export function terminalFrameStream(
  open: (signal: AbortSignal) => AsyncIterable<EnvironmentTerminalFrame>, signal: AbortSignal, maxBytes: number,
): TerminalFrameStream {
  const { abort, lifetime, notify, park, release } = streamWake(signal)
  const queue: { frame: EnvironmentTerminalFrame; bytes: number }[] = []
  const state: { bytes: number; complete: boolean; failure?: Error } = { bytes: 0, complete: false }
  const done = (async () => {
    try {
      lifetime.throwIfAborted()
      for await (const frame of open(lifetime)) {
        if (lifetime.aborted) break
        const bytes = Buffer.byteLength(JSON.stringify(frame))
        if (state.bytes + bytes > maxBytes) throw new RemoteError('environment/session-unavailable', 'Terminal viewer buffer exceeded its byte limit', {})
        queue.push({ frame, bytes }); state.bytes += bytes
        notify()
      }
    } catch (error) {
      if (!lifetime.aborted) state.failure = error instanceof Error ? error : new Error('Terminal stream failed', { cause: error })
    } finally {
      state.complete = true
      release()
      notify()
    }
  })()
  const iterator = (async function* () {
    try {
      while (!lifetime.aborted) {
        const item = queue.shift()
        if (item) { state.bytes -= item.bytes; yield item.frame }
        else if (state.complete) {
          if (state.failure !== undefined) throw state.failure
          return
        } else await park()
      }
    } finally { abort.abort(); await done; queue.length = 0; state.bytes = 0 }
  })()
  return { signal: lifetime, done, frames: { [Symbol.asyncIterator]() {
    return { next: () => iterator.next(), return: async () => {
      abort.abort(); await done; queue.length = 0; state.bytes = 0
      return iterator.return()
    } }
  } } }
}
