/** A single pending replacement snapshot with cancellation-owned source teardown. */
import type { EnvironmentSessionFrame } from './session-types.ts'
import { streamWake } from './stream-wake.ts'

/** A replacement stream whose producer can be joined without advancing a suspended consumer. */
export interface SessionFrameStream {
  /** Cancellation shared by the producer and any backpressured writer. */
  readonly signal: AbortSignal
  /** Single-consumer replacement snapshots; intermediate pending replacements may be coalesced. */
  readonly frames: AsyncIterable<EnvironmentSessionFrame>
  /** Settles after the source and its listeners have stopped, including on cancellation. */
  readonly done: Promise<void>
}

/**
 * Consume a source continuously while retaining at most its latest replacement snapshot.
 * @param open - source factory receiving the combined cancellation lifetime.
 * @param signal - owning runtime or operator lifetime.
 * @returns a stream and independently joinable producer teardown.
 */
export function sessionFrameStream(
  open: (signal: AbortSignal) => AsyncIterable<EnvironmentSessionFrame>, signal: AbortSignal,
): SessionFrameStream {
  const { abort, lifetime, notify, park, release } = streamWake(signal)
  const state: { latest?: EnvironmentSessionFrame; failure?: Error; complete: boolean } = { complete: false }
  const done = (async () => {
    try {
      lifetime.throwIfAborted()
      for await (const frame of open(lifetime)) {
        if (lifetime.aborted) break
        state.latest = frame
        notify()
      }
    } catch (error) {
      if (!lifetime.aborted) state.failure = error instanceof Error ? error : new Error('Session stream failed', { cause: error })
    } finally {
      state.complete = true
      release()
      notify()
    }
  })()
  const iterator = (async function* () {
    try {
      while (!lifetime.aborted) {
        if (state.latest !== undefined) {
          const frame = state.latest
          delete state.latest
          yield frame
        } else if (state.complete) {
          if (state.failure !== undefined) throw state.failure
          return
        } else await park()
      }
    } finally {
      abort.abort()
      await done
    }
  })()
  const frames: AsyncIterable<EnvironmentSessionFrame> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => iterator.next(),
        return: async () => { abort.abort(); await done; return iterator.return() },
      }
    },
  }
  return { frames, done, signal: lifetime }
}
