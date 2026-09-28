/** Bounded HTTPS peer calls with pinned identity and explicit deployment grants. */
import type { EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from './interaction-types.ts'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ResolvedConfig } from './config.ts'
import { descriptorSchema, requestSchema, type EnvironmentId, type PeerRequest } from './protocol.ts'
import type { EnvironmentDescriptor } from './protocol.ts'
import { followPeerSession, followPeerTerminal } from './peer-stream.ts'
import type { EnvironmentSessionFollowRequest, EnvironmentSessionFrame } from './session-types.ts'
import type { EnvironmentTeams } from './runtime.ts'

/** Public discovery URL; callers must still authenticate every operation. */
export const DESCRIPTOR_PATH = '/.well-known/dsh/environment'
/** Peer-only route, independent of browser operator authentication. */
export const PEER_PATH = '/dsh/environment-team'
const responseSchema = z.object({ environmentId: z.string(), result: z.string() }).strict()

/** Resolves current secrets without copying them into persisted records or model output. */
export class PeerTransport {
  constructor(private readonly id: EnvironmentId, private readonly config: ResolvedConfig, private readonly credentials: Pick<CredentialProvider, 'resolve'>) {}

  /** Open one ordered destination terminal stream.
   * @param environment - pinned destination identity.
   * @param request - destination terminal and exclusive input attachment.
   * @param signal - viewer lifetime.
   * @returns ordered terminal frames; the caller controls reconnection.
   */
  terminalFollow(
    environment: EnvironmentId, request: EnvironmentTerminalFollowRequest, signal: AbortSignal,
  ): AsyncIterable<EnvironmentTerminalFrame> {
    return followPeerTerminal(this, this.config, environment, request, signal)
  }

  /** Follow sanitized replacement frames on an identity-pinned authenticated peer.
   * @param environment - configured destination identity.
   * @param request - registered destination workspace and Session.
   * @param signal - owner cancellation.
   * @returns one physical stream generation; callers own retries.
   */
  follow(
    environment: EnvironmentId, request: EnvironmentSessionFollowRequest, signal: AbortSignal,
  ): AsyncIterable<EnvironmentSessionFrame> {
    return followPeerSession(this, this.config, environment, request, signal)
  }

  /** Resolve the current peer credentials before one operation.
   * @returns validated pairwise secrets, never persisted with configuration.
   */
  async tokens(): Promise<Map<EnvironmentId, string>> {
    const tokens = new Map<EnvironmentId, string>()
    for (const peer of this.config.peers) {
      if (peer.environmentId === this.id) throw new Error('an environment cannot pair with itself')
      const token = (await this.credentials.resolve(credentialRef(peer.tokenEnv)))?.value
      if (!token || Buffer.byteLength(token) < 32) throw new Error(`peer credential ${peer.tokenEnv} must contain at least 32 bytes`)
      if ([...tokens.values()].includes(token)) throw new Error('each peer needs a distinct credential')
      tokens.set(peer.environmentId, token)
    }
    return tokens
  }

  /**
   * Authenticate one non-browser request without accepting claimed caller identity.
   * @param request - Incoming headers supplied by the server.
   * @returns the granted environment, or undefined when authentication fails.
   */
  async authenticate(request: IncomingMessage): Promise<EnvironmentId | undefined> {
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) return undefined
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ')) return undefined
    const digest = createHash('sha256').update(authorization.slice(7)).digest()
    for (const [id, token] of await this.tokens()) {
      if (timingSafeEqual(digest, createHash('sha256').update(token).digest())) return id
    }
    return undefined
  }

  /**
   * Verify descriptor identity, then issue one request without automatic mutation retries.
   * @param environment - Pinned destination identity from configuration.
   * @param request - Complete validated operation.
   * @param signal - Runtime or caller cancellation.
   * @returns the authenticated destination's bounded result text.
   */
  async call(environment: EnvironmentId, request: PeerRequest, signal: AbortSignal): Promise<string> {
    const peer = this.config.peers.find(item => item.environmentId === environment)
    const token = (await this.tokens()).get(environment)
    if (!peer || !token) throw new Error('peer is not configured')
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const descriptor = await this.describe(environment, bounded)
    if (request.kind === 'workspace' && !descriptor.capabilities.workspaceBrowser) throw new Error('peer does not support workspace management')
    if (request.kind === 'session' && !descriptor.capabilities.workspaceSessions) throw new Error('peer does not support workspace sessions')
    if (request.kind === 'session' && request.request.action === 'read' && request.request.beforeSeq !== undefined && !descriptor.capabilities.workspaceSessionHistory) throw new RemoteError('environment/session-unsupported', 'Peer does not support Session history paging', {})
    if (request.kind === 'session-interaction' && !descriptor.capabilities.workspaceSessionInteractions) throw new Error('peer does not support session interactions')
    if (request.kind === 'team-dashboard' && !descriptor.capabilities.teamDashboard) throw new Error('peer does not support team dashboard')
    const body = JSON.stringify(request)
    if (Buffer.byteLength(body) > this.config.maxBytes) throw new Error('peer request byte limit reached')
    const response = await fetch(`${peer.url}${PEER_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body, signal: bounded, redirect: 'error',
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`peer operation rejected with HTTP ${response.status}`) }
    const result = responseSchema.parse(JSON.parse(await boundedResponse(response, this.config.maxBytes)))
    if (result.environmentId !== environment) throw new Error('peer response identity mismatch')
    return result.result
  }

  /** Fetch a bounded descriptor and verify the pinned identity before using a route.
   * @param environment - configured destination identity.
   * @param signal - owner cancellation.
   * @returns the verified descriptor; route and identity failures reject.
   */
  async describe(environment: EnvironmentId, signal: AbortSignal): Promise<EnvironmentDescriptor> {
    const peer = this.config.peers.find(item => item.environmentId === environment)
    if (!peer) throw new Error('peer is not configured')
    const response = await fetch(`${peer.url}${DESCRIPTOR_PATH}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw new Error('peer descriptor is unavailable') }
    const descriptor = descriptorSchema.parse(JSON.parse(await boundedResponse(response, this.config.maxBytes)))
    if (descriptor.environmentId !== environment) throw new Error('peer environment identity mismatch')
    return descriptor
  }

  /**
   * Handle one peer request with authentication before reading its body.
   * @param runtime - Target environment's operation owner.
   * @param request - Incoming HTTP request.
   * @param response - Response owned through completion.
   */
  async handle(runtime: EnvironmentTeams, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json')
    let peer: EnvironmentId | undefined
    try { peer = await this.authenticate(request) } catch {
      // A missing or invalid rotated credential cannot authenticate a peer.
      response.writeHead(401).end(); return
    }
    if (!peer) { response.writeHead(401).end(); return }
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') { response.writeHead(415).end(); return }
    const abort = new AbortController()
    const closed = () => { abort.abort() }
    response.once('close', closed)
    request.setTimeout(this.config.requestTimeoutMs, () => request.destroy())
    try {
      const chunks: Buffer[] = []
      let size = 0
      // This server leaves IncomingMessage in its default Buffer mode.
      for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.byteLength
        if (size > this.config.maxBytes) { response.writeHead(413).end(); return }
        chunks.push(chunk)
      }
      const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (input.environmentId !== this.id) { response.writeHead(409).end(); return }
      const result = await runtime.receive(peer, input, abort.signal)
      const output = JSON.stringify({ environmentId: this.id, result })
      if (Buffer.byteLength(output) > this.config.maxBytes) { response.writeHead(413).end(); return }
      response.end(output)
    } catch (error) {
      // Protocol failures intentionally omit payloads, paths, credentials, and peer diagnostics.
      response.writeHead(error instanceof z.ZodError ? 400 : 403).end(JSON.stringify({ error: 'peer operation rejected' }))
    } finally {
      response.off('close', closed)
      request.setTimeout(0)
    }
  }
}

async function boundedResponse(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new Error('peer response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > maximum) throw new Error('peer response byte limit reached')
      chunks.push(item.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
