/** Bounded HTTPS peer calls with pinned identity and explicit deployment grants. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { ResolvedConfig } from './config.ts'
import { descriptorSchema, requestSchema, type EnvironmentId, type PeerRequest } from './protocol.ts'
import type { EnvironmentTeams } from './runtime.ts'

/** Public discovery URL; callers must still authenticate every operation. */
export const DESCRIPTOR_PATH = '/.well-known/dsh/environment'
/** Peer-only route, independent of browser operator authentication. */
export const PEER_PATH = '/dsh/environment-team'
const responseSchema = z.object({ environmentId: z.string(), result: z.string() }).strict()

/** Validates secrets once without copying them into persisted records or model output. */
export class PeerTransport {
  private readonly tokens = new Map<EnvironmentId, string>()

  constructor(private readonly id: EnvironmentId, private readonly config: ResolvedConfig) {
    for (const peer of config.peers) {
      if (peer.environmentId === id) throw new Error('an environment cannot pair with itself')
      const token = process.env[peer.tokenEnv]
      if (!token || Buffer.byteLength(token) < 32) throw new Error(`peer credential variable ${peer.tokenEnv} must contain at least 32 bytes`)
      if ([...this.tokens.values()].includes(token)) throw new Error('each peer needs a distinct credential')
      this.tokens.set(peer.environmentId, token)
    }
  }

  /**
   * Authenticate one non-browser request without accepting claimed caller identity.
   * @param request - Incoming headers supplied by the server.
   * @returns the granted environment, or undefined when authentication fails.
   */
  authenticate(request: IncomingMessage): EnvironmentId | undefined {
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) return undefined
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ')) return undefined
    const digest = createHash('sha256').update(authorization.slice(7)).digest()
    for (const [id, token] of this.tokens) {
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
    const token = this.tokens.get(environment)
    if (!peer || !token) throw new Error('peer is not configured')
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const descriptorResponse = await fetch(`${peer.url}${DESCRIPTOR_PATH}`, { signal: bounded, redirect: 'error' })
    if (!descriptorResponse.ok) { await descriptorResponse.body?.cancel(); throw new Error('peer descriptor is unavailable') }
    const descriptor = descriptorSchema.parse(JSON.parse(await boundedResponse(descriptorResponse, this.config.maxBytes)))
    if (descriptor.environmentId !== environment) throw new Error('peer environment identity mismatch')
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

  /**
   * Handle one peer request with authentication before reading its body.
   * @param runtime - Target environment's operation owner.
   * @param request - Incoming HTTP request.
   * @param response - Response owned through completion.
   */
  async handle(runtime: EnvironmentTeams, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json')
    const peer = this.authenticate(request)
    if (!peer) { response.writeHead(401).end(); return }
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') { response.writeHead(415).end(); return }
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
      const result = await runtime.receive(peer, input)
      const output = JSON.stringify({ environmentId: this.id, result })
      if (Buffer.byteLength(output) > this.config.maxBytes) { response.writeHead(413).end(); return }
      response.end(output)
    } catch (error) {
      // Protocol failures intentionally omit payloads, paths, credentials, and peer diagnostics.
      response.writeHead(error instanceof z.ZodError ? 400 : 403).end(JSON.stringify({ error: 'peer operation rejected' }))
    } finally {
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
