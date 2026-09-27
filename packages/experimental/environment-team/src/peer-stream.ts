/** Authenticated SSE delivery of bounded, destination-scoped Session replacement frames. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { ParseError } from 'eventsource-parser'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { ResolvedConfig } from './config.ts'
import { environmentIdSchema, type EnvironmentId } from './protocol.ts'
import type { EnvironmentTeams } from './runtime.ts'
import type { PeerTransport } from './transport.ts'
import { environmentSessionFrameSchema, sessionFollowRequestSchema } from './session-protocol.ts'
import type { EnvironmentSessionFollowRequest, EnvironmentSessionFrame } from './session-types.ts'

/** Peer-only Session follow route; browser callers continue through their authenticated BFF. */
export const SESSION_FOLLOW_PATH = '/dsh/environment-team/session-follow'
const requestSchema = z.object({ environmentId: environmentIdSchema, request: sessionFollowRequestSchema }).strict()
const terminalSchema = z.object({ code: z.enum(['environment/session-denied', 'environment/session-unsupported', 'environment/session-protocol', 'environment/session-unavailable']) }).strict()

/**
 * Open a single identity-pinned peer generation; the Client owns reconnection.
 * @param transport - current pairwise authentication and descriptor resolver.
 * @param config - resolved frame, connection and idle limits.
 * @param environment - pinned destination identity.
 * @param request - destination workspace and Session.
 * @param signal - operator and management lifetime.
 * @returns strict replacement frames from this destination only.
 */
export async function* followPeerSession(
  transport: PeerTransport, config: ResolvedConfig, environment: EnvironmentId,
  request: EnvironmentSessionFollowRequest, signal: AbortSignal,
): AsyncIterable<EnvironmentSessionFrame> {
  const abort = new AbortController()
  const lifetime = AbortSignal.any([signal, abort.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<import('eventsource-parser').EventSourceMessage> | undefined
  const arm = (milliseconds: number) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { abort.abort(new Error('peer stream deadline reached')) }, milliseconds)
  }
  try {
    lifetime.throwIfAborted()
    arm(config.requestTimeoutMs)
    const peer = config.peers.find(item => item.environmentId === environment)
    const token = (await transport.tokens()).get(environment)
    if (!peer || !token) throw new RemoteError('environment/session-denied', 'Peer is not configured', {})
    const descriptor = await transport.describe(environment, lifetime)
    if (!descriptor.capabilities.workspaceSessionFollow) throw new RemoteError('environment/session-unsupported', 'Peer does not support live Sessions', {})
    const body = JSON.stringify({ environmentId: environment, request })
    if (Buffer.byteLength(body) > config.maxBytes) throw new RemoteError('environment/session-protocol', 'Peer request byte limit reached', {})
    const response = await fetch(`${peer.url}${SESSION_FOLLOW_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, redirect: 'error', signal: lifetime })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) throw new RemoteError('environment/session-denied', 'Peer refused Session access', {})
      if (response.status === 404) throw new RemoteError('environment/session-unsupported', 'Peer does not support live Sessions', {})
      if (response.status >= 500) throw new RemoteError('environment/session-unavailable', 'Peer Session service is unavailable', {})
      throw new RemoteError('environment/session-protocol', 'Peer rejected the follow request', {})
    }
    if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await response.body?.cancel()
      throw new RemoteError('environment/session-protocol', 'Peer stream has an invalid content type', {})
    }
    arm(config.sessionStreamIdleTimeoutMs)
    const parsed = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({
      maxBufferSize: config.maxBytes,
      onError: 'terminate',
      onComment: () => { arm(config.sessionStreamIdleTimeoutMs) },
    }))
    reader = parsed.getReader()
    while (!lifetime.aborted) {
      const next = await reader.read()
      if (next.done) throw new RemoteError('environment/session-unavailable', 'Peer Session stream ended', {})
      arm(config.sessionStreamIdleTimeoutMs)
      const eventLine = next.value.event === undefined ? '' : `event: ${next.value.event}\n`
      if (Buffer.byteLength(`${eventLine}data: ${next.value.data}\n\n`) > config.maxBytes) throw new RemoteError('environment/session-protocol', 'Peer frame byte limit reached', {})
      if (next.value.event === 'error') {
        const terminal = terminalSchema.safeParse(parseJson(next.value.data))
        if (!terminal.success) throw new RemoteError('environment/session-protocol', 'Peer sent an invalid terminal frame', {})
        throw new RemoteError(terminal.data.code, 'Peer Session stream closed', {})
      }
      if (next.value.event !== undefined && next.value.event !== 'message') throw new RemoteError('environment/session-protocol', 'Peer sent an unknown stream event', {})
      let frame: EnvironmentSessionFrame
      try { frame = environmentSessionFrameSchema.parse(JSON.parse(next.value.data)) } catch (error) {
        throw new RemoteError('environment/session-protocol', 'Peer sent an invalid Session frame', {}, { cause: error })
      }
      if (frame.environmentId !== environment || frame.workspaceId !== request.workspaceId || frame.sessionId !== request.sessionId) throw new RemoteError('environment/session-protocol', 'Peer Session identity mismatch', {})
      lifetime.throwIfAborted()
      yield frame
    }
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof RemoteError) throw error
    if (error instanceof ParseError) throw new RemoteError('environment/session-protocol', 'Peer sent invalid SSE framing', {}, { cause: error })
    throw new RemoteError('environment/session-unavailable', 'Peer Session stream is unavailable', {}, { cause: error })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    abort.abort()
    if (reader) {
      await reader.cancel().catch((_closedReader: unknown) => { /* Aborted or failed bodies are already closed. */ })
      reader.releaseLock()
    }
  }
}

/**
 * Serve one authenticated peer stream with bounded writes and periodic credential rechecks.
 * @param transport - authentication owner.
 * @param runtime - destination Session lifetime owner.
 * @param id - destination's durable identity.
 * @param config - resolved deadlines and frame limit.
 * @param request - incoming HTTP request.
 * @param response - response owned until source and pending writes stop.
 * @param signal - route registration lifetime; unloading joins admitted handlers.
 */
export async function handlePeerSession(
  transport: PeerTransport, runtime: EnvironmentTeams, id: EnvironmentId, config: ResolvedConfig,
  request: IncomingMessage, response: ServerResponse, signal: AbortSignal,
): Promise<void> {
  response.setHeader('cache-control', 'no-store')
  let peer: EnvironmentId | undefined
  try { peer = await transport.authenticate(request) } catch (_invalidCredential) {
    response.writeHead(401).end(); return
  }
  if (!peer) { response.writeHead(401).end(); return }
  if (signal.aborted) { response.destroy(); return }
  if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') { response.writeHead(415).end(); return }
  const abort = new AbortController()
  const closed = () => { abort.abort() }
  const stopped = () => { abort.abort(); response.destroy() }
  signal.addEventListener('abort', stopped, { once: true })
  response.once('close', closed)
  request.setTimeout(config.requestTimeoutMs, () => { request.destroy() })
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let checking: Promise<void> | undefined
  const heartbeatState: { pulse: Promise<void> | undefined } = { pulse: undefined }
  let writes = Promise.resolve()
  let iterator: AsyncIterator<EnvironmentSessionFrame> | undefined
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.byteLength
      if (size > config.maxBytes) { response.writeHead(413).end(); return }
      chunks.push(chunk)
    }
    const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (input.environmentId !== id) { response.writeHead(409).end(); return }
    const stream = runtime.follow(peer, input.request, abort.signal)
    iterator = stream.frames[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || stream.signal.aborted) throw new RemoteError('environment/session-unavailable', 'Session stream stopped before opening', {})
    const enqueue = (data: string): Promise<void> => {
      const next = writes.then(() => writeFrame(response, data, stream.signal, config.requestTimeoutMs))
      writes = next.catch((_failedWrite: unknown) => { /* The submitting frame or heartbeat observes this rejection. */ })
      return next
    }
    const encode = (frame: EnvironmentSessionFrame): string => {
      const data = `data: ${JSON.stringify(frame)}\n\n`
      if (Buffer.byteLength(data) > config.maxBytes) throw new RemoteError('environment/session-protocol', 'Session frame byte limit reached', {})
      return data
    }
    const opening = encode(first.value)
    response.setHeader('content-type', 'text/event-stream')
    response.setHeader('x-accel-buffering', 'no')
    request.setTimeout(0)
    await enqueue(opening)
    heartbeat = setInterval(() => {
      if (checking || stream.signal.aborted) return
      checking = (async () => {
        if (await transport.authenticate(request) !== peer) throw new Error('peer credential revoked')
        stream.signal.throwIfAborted()
        if (!heartbeatState.pulse) {
          const pending = enqueue(': heartbeat\n\n')
          heartbeatState.pulse = pending
          void pending.catch(() => { abort.abort(); response.destroy() }).finally(() => {
            heartbeatState.pulse = undefined
          })
        }
      })().catch(() => { abort.abort(); response.destroy() }).finally(() => { checking = undefined })
    }, config.sessionStreamHeartbeatMs)
    while (!stream.signal.aborted) {
      const next = await iterator.next()
      if (next.done) break
      await enqueue(encode(next.value))
    }
    response.end()
  } catch (error) {
    if (response.headersSent) {
      const code: unknown = error instanceof RemoteError ? error.code : 'environment/session-unavailable'
      const terminal = terminalSchema.safeParse({ code })
      const data = `event: error\ndata: ${JSON.stringify({ code: terminal.success ? terminal.data.code : 'environment/session-unavailable' })}\n\n`
      if (abort.signal.aborted || Buffer.byteLength(data) > config.maxBytes) response.destroy()
      else {
        await writes
        try {
          await writeFrame(response, data, AbortSignal.any([abort.signal, signal]), config.requestTimeoutMs)
          response.end()
        } catch (_closedResponse) { response.destroy() }
      }
    }
    else {
      const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400
        : error instanceof RemoteError && error.code === 'environment/session-denied' ? 403
          : error instanceof RemoteError && error.code === 'environment/session-unsupported' ? 404
            : error instanceof RemoteError && error.code === 'environment/session-protocol' ? 422 : 503
      response.writeHead(status).end()
    }
  } finally {
    abort.abort()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    await checking
    await Promise.allSettled([heartbeatState.pulse])
    await writes
    await iterator?.return?.()
    response.off('close', closed)
    signal.removeEventListener('abort', stopped)
    request.setTimeout(0)
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch (error) {
    throw new RemoteError('environment/session-protocol', 'Peer sent invalid JSON', {}, { cause: error })
  }
}

async function writeFrame(response: ServerResponse, data: string, signal: AbortSignal, timeout: number): Promise<void> {
  signal.throwIfAborted()
  if (response.write(data)) return
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      response.off('drain', drained)
      response.off('error', failed)
      signal.removeEventListener('abort', cancelled)
      if (error) reject(error); else resolve()
    }
    const drained = () => { finish() }
    const failed = (error: Error) => { finish(error) }
    const cancelled = () => { finish(new Error('Session stream write cancelled')) }
    const timer = setTimeout(() => { finish(new Error('Session stream write deadline reached')) }, timeout)
    response.once('drain', drained)
    response.once('error', failed)
    signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted) cancelled()
  })
}
