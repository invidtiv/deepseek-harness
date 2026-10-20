/** Routes a viewer's terminal commands from separate interaction calls into the attachment that owns its input uplink. */
import type { TerminalFrame, TerminalInput, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { EnvironmentId } from './protocol.ts'
import type { EnvironmentInteractionRequest, EnvironmentTerminalAttachmentId } from './interaction-types.ts'

/** Input command fields; the route assigns the attachment-scoped sequence. */
export type TerminalCommand =
  | { readonly type: 'write'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }

/** Caller, Session and terminal that opened one attachment; commands from any other owner are rejected. */
export interface TerminalRouteOwner {
  readonly peer: EnvironmentId
  readonly sessionId: EnvironmentInteractionRequest['sessionId']
  readonly terminalId: WebTerminalId
}

/** One live attachment's single-consumer uplink and its unacknowledged commands. */
export class TerminalInputRoute {
  private sequence = 0
  private readonly queue: TerminalInput[] = []
  private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  private wake: (() => void) | undefined
  private failure: Error | undefined

  /** @param owner - identities every routed command must match. */
  constructor(readonly owner: TerminalRouteOwner) {}

  /**
   * Commands in send order, ending when the route closes; consumed once by the terminal attachment.
   * @returns the uplink iterable passed to the terminal controller.
   */
  async *input(): AsyncIterable<TerminalInput> {
    for (;;) {
      const next = this.queue.shift()
      if (next !== undefined) yield next
      else if (this.failure !== undefined) return
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /**
   * Queue one command and wait for the terminal's acceptance; a delivered command is never replayed.
   * @param command - write or resize fields.
   * @param signal - caller cancellation; aborting stops waiting but cannot retract a queued command.
   * @returns after the terminal acknowledges the command without refusal.
   */
  send(command: TerminalCommand, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const sequence = ++this.sequence
    return new Promise<void>((resolve, reject) => {
      const aborted = (): void => { this.pending.delete(sequence); reject(signal.reason instanceof Error ? signal.reason : new Error('Terminal input was cancelled')) }
      signal.addEventListener('abort', aborted, { once: true })
      this.pending.set(sequence, {
        resolve: () => { signal.removeEventListener('abort', aborted); resolve() },
        reject: (error) => { signal.removeEventListener('abort', aborted); reject(error) },
      })
      this.queue.push(command.type === 'write' ? { type: 'write', sequence, data: command.data } : { type: 'resize', sequence, cols: command.cols, rows: command.rows })
      this.notify()
    })
  }

  /**
   * Settle the command an acknowledgement names; refusals reject it.
   * @param frame - terminal acknowledgement for this attachment.
   */
  acknowledge(frame: Extract<TerminalFrame, { type: 'ack' }>): void {
    const pending = this.pending.get(frame.sequence)
    if (pending === undefined) return
    this.pending.delete(frame.sequence)
    if (frame.refusal === undefined) pending.resolve()
    else pending.reject(new Error(`Terminal input was refused: ${frame.refusal}`))
  }

  /**
   * End the uplink and reject every unacknowledged command; idempotent.
   * @param error - reason reported to waiting callers.
   */
  close(error: Error): void {
    this.failure ??= error
    for (const pending of this.pending.values()) pending.reject(this.failure)
    this.pending.clear()
    this.queue.length = 0
    this.notify()
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** Live attachments owned by one service; operator settings and the peer runtime each route only the attachments they opened. */
export class TerminalInputRoutes {
  private readonly routes = new Map<EnvironmentTerminalAttachmentId, TerminalInputRoute>()

  /**
   * Register a fresh attachment identity.
   * @param attachmentId - viewer-generated physical connection identity.
   * @param owner - caller, Session and terminal of the attachment.
   * @returns the route; the caller closes and releases it when the attachment ends.
   */
  open(attachmentId: EnvironmentTerminalAttachmentId, owner: TerminalRouteOwner): TerminalInputRoute {
    if (this.routes.has(attachmentId)) throw new Error('Terminal attachment identity is already in use')
    const route = new TerminalInputRoute(owner)
    this.routes.set(attachmentId, route)
    return route
  }

  /**
   * Close and unregister a route if it is still the registered one.
   * @param attachmentId - identity passed to `open`.
   * @param route - route returned by `open`.
   */
  release(attachmentId: EnvironmentTerminalAttachmentId, route: TerminalInputRoute): void {
    route.close(new Error('Terminal attachment ended'))
    if (this.routes.get(attachmentId) === route) this.routes.delete(attachmentId)
  }

  /**
   * Deliver a command to the attachment that owner opened.
   * @param attachmentId - target attachment.
   * @param owner - caller, Session and terminal named by the command.
   * @param command - write or resize fields.
   * @param signal - caller cancellation.
   * @returns after terminal acceptance.
   */
  send(
    attachmentId: EnvironmentTerminalAttachmentId, owner: TerminalRouteOwner, command: TerminalCommand, signal: AbortSignal,
  ): Promise<void> {
    const route = this.routes.get(attachmentId)
    const owned = route !== undefined && route.owner.peer === owner.peer
      && route.owner.sessionId === owner.sessionId && route.owner.terminalId === owner.terminalId
    if (!owned) {
      return Promise.reject(new Error('Terminal attachment is not connected'))
    }
    return route.send(command, signal)
  }
}
