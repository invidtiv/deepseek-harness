/** Independent pairing provider and bounded public exchange routes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-config-editor'
import { z } from 'zod'
import { EnvironmentPairing, PAIRING_REDEEM_PATH, PAIRING_STATUS_PATH } from './pairing-core.ts'
import { pairingDomain } from './pairing-store.ts'
import { readEnvironmentConfiguration } from './pairing-configuration.ts'
import { resolveConfig } from './config.ts'
import { PeerTransport } from './transport.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Invitation lifecycle remains mounted while execution configuration reloads. */
    environmentPairing: EnvironmentPairing
  }
}

/** Stable provider identity. */
export const name = 'environment-pairing'
/** Profile, secret, persistence and public HTTP services used by pairing. */
export const inject = ['configEditor', 'credentials', 'storageDomain', 'webServer']

/** Mount the invitation owner separately from the execution runtime.
 * @param ctx - pairing provider lifetime.
 */
export async function apply(ctx: Context): Promise<void> {
  const current = await readEnvironmentConfiguration(ctx)
  const domain = await ctx.storageDomain.open(pairingDomain)
  const bound = domain.global.get().environmentId
  try {
    if (bound !== null && bound !== current.environmentId) throw new Error('Pairing storage belongs to another installation')
    if (bound === null) await domain.global.set({ environmentId: current.environmentId })
  } catch (error) { await domain.close(); throw error }
  const pairing = new EnvironmentPairing(ctx, current.environmentId, domain)
  const abort = new AbortController()
  const active = new Set<Promise<void>>()
  ctx.effect(() => async () => { abort.abort(); await pairing.close(); await Promise.allSettled([...active]) })
  ctx.provide('environmentPairing', pairing)
  for (const path of [PAIRING_REDEEM_PATH, PAIRING_STATUS_PATH]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler(request, response) {
      const pending = handle(ctx, pairing, request, response, abort.signal)
      active.add(pending)
      return pending.finally(() => active.delete(pending))
    } }))
  }
}

async function handle(
  ctx: Context, pairing: EnvironmentPairing, request: IncomingMessage, response: ServerResponse, signal: AbortSignal,
): Promise<void> {
  const stop = () => { request.destroy(); response.destroy() }
  signal.addEventListener('abort', stop, { once: true })
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json')
  try {
    signal.throwIfAborted()
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) { response.writeHead(403).end(); return }
    const current = await readEnvironmentConfiguration(ctx)
    const config = resolveConfig(current.config)
    request.setTimeout(config.requestTimeoutMs, stop)
    if (request.url === PAIRING_STATUS_PATH) {
      if (request.method !== 'GET') { response.writeHead(405).end(); return }
      const peerId = await new PeerTransport(current.environmentId, config, ctx.credentials).authenticate(request)
      if (!peerId) { response.writeHead(401).end(); return }
      response.end(JSON.stringify({ environmentId: current.environmentId, peerId }))
      return
    }
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') { response.writeHead(415).end(); return }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.byteLength
      if (size > config.maxBytes) { response.writeHead(413).end(); return }
      chunks.push(chunk)
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const result = await pairing.redeem(input)
    if (!signal.aborted) response.end(JSON.stringify(result))
  } catch (error) {
    if (!response.destroyed) response.writeHead(error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 403).end()
  } finally { request.setTimeout(0); signal.removeEventListener('abort', stop) }
}
