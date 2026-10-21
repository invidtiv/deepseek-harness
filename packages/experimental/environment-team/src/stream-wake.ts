/** Cancellation lifetime and consumer wake-up shared by the single-consumer frame streams. */

/** Cancellation and wake-up for one producer and one suspended consumer. */
export interface StreamWake {
  /** Cancels the lifetime from the consumer side. */
  readonly abort: AbortController
  /** Aborts when the owner or the consumer cancels. */
  readonly lifetime: AbortSignal
  /** Resumes the consumer if it is suspended in `park`. */
  readonly notify: () => void
  /** Suspends the consumer until the next `notify`. */
  readonly park: () => Promise<void>
  /** Stops waking the consumer on cancellation once the producer has settled. */
  readonly release: () => void
}

/**
 * Combine an owner lifetime with consumer cancellation and a single wake-up slot.
 * @param signal - owning runtime or operator lifetime.
 * @returns the combined lifetime and the wake-up operations for its producer and consumer.
 */
export function streamWake(signal: AbortSignal): StreamWake {
  const abort = new AbortController()
  const lifetime = AbortSignal.any([signal, abort.signal])
  let wake: (() => void) | undefined
  const notify = () => { const current = wake; wake = undefined; current?.() }
  lifetime.addEventListener('abort', notify, { once: true })
  return {
    abort, lifetime, notify,
    park: () => new Promise<void>((resolve) => { wake = resolve }),
    release: () => { lifetime.removeEventListener('abort', notify) },
  }
}
