/**
 * Peer Harness registry. Transports drive other DeepSeek Harness instances;
 * this service owns the named registry, peer selection, and the operations
 * every consumer addresses by peer name.
 * @module @deepseek-ai/dsh-peer
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  PeerAskRequest,
  PeerAskResult,
  PeerMessage,
  PeerSessionSummary,
  PeerTranscriptRequest,
  PeerTransport,
} from './types.ts'

export type {
  PeerAskRequest,
  PeerAskResult,
  PeerMessage,
  PeerSessionSummary,
  PeerTranscriptRequest,
  PeerTransport,
  PeerUsage,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    peers: PeerService
  }
}

/** Machine-routable peer service failures. */
export type PeerErrorCode =
  | 'AMBIGUOUS_PEER'
  | 'DUPLICATE_PEER'
  | 'NO_PEER'
  | 'SERVICE_DISPOSING'

/** Error carrying a stable {@link PeerErrorCode}. */
export class PeerError extends Error {
  constructor(message: string, readonly code: PeerErrorCode) {
    super(message)
    this.name = 'PeerError'
  }
}

/** Registry of named peer Harness transports for one Host composition. */
export class PeerService extends Service {
  private readonly transports = new Map<string, PeerTransport>()
  private disposing = false

  constructor(ctx: Context) {
    super(ctx, 'peers')
    ctx.effect(() => () => {
      this.disposing = true
      this.transports.clear()
    }, 'peers teardown')
  }

  /**
   * Register one peer transport for this effect scope.
   * @param transport - transport with a non-empty unique peer name.
   * @returns disposer that removes exactly this contribution.
   */
  register(transport: PeerTransport): () => void {
    if (transport.id.length === 0) throw new Error('peer transport id must be non-empty')
    if (this.transports.has(transport.id)) {
      throw new PeerError(`a peer named "${transport.id}" is already registered`, 'DUPLICATE_PEER')
    }
    const dispose = this.ctx.effect(() => {
      this.transports.set(transport.id, transport)
      return () => {
        if (this.transports.get(transport.id) === transport) this.transports.delete(transport.id)
      }
    }, 'peers.register()')
    return () => void dispose()
  }

  /**
   * List registered peer names in registration order.
   * @returns fresh peer names.
   */
  list(): string[] {
    return [...this.transports.keys()]
  }

  /**
   * Read one peer's visible session rows.
   * @param peer - registered peer name; omission requires exactly one peer.
   * @param signal - caller cancellation.
   * @returns peer session summaries ordered by the peer's own activity order.
   */
  listSessions(peer: string | undefined, signal?: AbortSignal): Promise<readonly PeerSessionSummary[]> {
    return this.resolve(peer).listSessions(signal)
  }

  /**
   * Run one task on a peer and wait for its turn to end.
   * @param peer - registered peer name; omission requires exactly one peer.
   * @param request - task text plus optional session, directory, preset, and bound.
   * @param signal - caller cancellation.
   * @returns the peer's terminal outcome for that turn.
   */
  ask(peer: string | undefined, request: PeerAskRequest, signal?: AbortSignal): Promise<PeerAskResult> {
    return this.resolve(peer).ask(request, signal)
  }

  /**
   * Read one bounded transcript tail from a peer session.
   * @param peer - registered peer name; omission requires exactly one peer.
   * @param request - target session and tail bounds.
   * @param signal - caller cancellation.
   * @returns peer messages oldest first within the requested tail.
   */
  transcript(peer: string | undefined, request: PeerTranscriptRequest, signal?: AbortSignal): Promise<readonly PeerMessage[]> {
    return this.resolve(peer).transcript(request, signal)
  }

  private resolve(peer: string | undefined): PeerTransport {
    if (this.disposing) throw new PeerError('peer service is disposing', 'SERVICE_DISPOSING')
    if (peer !== undefined) {
      const found = this.transports.get(peer)
      if (found === undefined) {
        throw new PeerError(`no peer named "${peer}"; registered: ${this.list().join(', ') || 'none'}`, 'NO_PEER')
      }
      return found
    }
    const all = [...this.transports.values()]
    const first = all[0]
    if (first === undefined) throw new PeerError('no peer Harness is configured', 'NO_PEER')
    if (all.length > 1) {
      throw new PeerError(`multiple peers are configured (${this.list().join(', ')}); name one`, 'AMBIGUOUS_PEER')
    }
    return first
  }
}

export default PeerService
