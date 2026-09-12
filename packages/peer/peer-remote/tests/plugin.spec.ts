// The `peer-remote` plugin entry: origin validation at load, cookie resolution
// through the credentials seam, its launch-environment fallback, and the
// registered transport.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { RemotePeerError } from '@deepseek-ai/dsh-peer-remote'
import * as PeerRemote from '@deepseek-ai/dsh-peer-remote'
import PeerService from '@deepseek-ai/dsh-peer'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

/** Credential reference this spec resolves; the launch environment may also carry it. */
const COOKIE_ENV = 'DSH_PEER_PLUGIN_TEST_COOKIE'
const STORED_COOKIE = 'dsh_session=from-store'
const AMBIENT_COOKIE = 'dsh_session=from-environment'
const originalCookie = process.env[COOKIE_ENV]

/** Cookie header each accepted Remote call carried. */
interface FakePeer {
  readonly baseUrl: string
  readonly cookies: (string | undefined)[]
  close(): Promise<void>
}

/** A peer surface that answers every Remote call with an empty session list. */
async function startFakePeer(): Promise<FakePeer> {
  const cookies: (string | undefined)[] = []
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      cookies.push(request.headers.cookie)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value: { items: [] } },
      }))
    })().catch(() => { response.destroy() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    cookies,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

/** A credentials provider whose stored value is an empty string, which counts as absent. */
class EmptyCredentials extends MemoryCredentials {
  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve({ value: '', source: 'test' })
  }
}

const contexts: Context[] = []
const peers: FakePeer[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const peer of peers.splice(0)) await peer.close()
  if (originalCookie === undefined) Reflect.deleteProperty(process.env, COOKIE_ENV)
  else process.env[COOKIE_ENV] = originalCookie
})

/** A root context carrying the peer registry, which `peer-remote` injects. */
async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(PeerService)
  return ctx
}

async function fakePeer(): Promise<FakePeer> {
  const peer = await startFakePeer()
  peers.push(peer)
  return peer
}

function transportConfig(baseUrl: string, overrides: Record<string, unknown> = {}): PeerRemote.Config {
  return {
    peerId: 'plugin-peer',
    baseUrl,
    cookieEnv: COOKIE_ENV,
    requestTimeoutMs: 2_000,
    askTimeoutMs: 2_000,
    pollIntervalMs: 1,
    ...overrides,
  }
}

describe('peer-remote plugin entry', () => {
  it('rejects a baseUrl that is not an absolute URL at load', async () => {
    const ctx = await mountRegistry()

    await expect(ctx.plugin(PeerRemote, transportConfig('not a url')))
      .rejects.toThrow('peer-remote baseUrl is not an absolute URL: "not a url"')

    expect(ctx.peers.list()).toEqual([])
  })

  it('rejects a baseUrl whose protocol is neither http nor https at load', async () => {
    const ctx = await mountRegistry()

    await expect(ctx.plugin(PeerRemote, transportConfig('ftp://peer.test')))
      .rejects.toThrow('peer-remote baseUrl must be http or https, got ftp:')

    expect(ctx.peers.list()).toEqual([])
  })

  it('registers the peer under its configured id for http and https origins', async () => {
    const ctx = await mountRegistry()

    await ctx.plugin(PeerRemote, transportConfig('http://peer.test'))
    expect(ctx.peers.list()).toEqual(['plugin-peer'])

    await ctx.plugin(PeerRemote, transportConfig('https://peer.test', { peerId: 'secure-peer' }))
    expect(ctx.peers.list()).toEqual(['plugin-peer', 'secure-peer'])
  })

  it('resolves the cookie through a mounted credentials service before the environment', async () => {
    const peer = await fakePeer()
    process.env[COOKIE_ENV] = AMBIENT_COOKIE
    const ctx = await mountRegistry()
    await ctx.plugin(MemoryCredentials, { [COOKIE_ENV]: STORED_COOKIE })
    await ctx.plugin(PeerRemote, transportConfig(peer.baseUrl))

    await expect(ctx.peers.listSessions(undefined)).resolves.toEqual([])

    expect(peer.cookies).toEqual([STORED_COOKIE])
  })

  it('falls back to the launch environment when the credentials service holds no value', async () => {
    const peer = await fakePeer()
    process.env[COOKIE_ENV] = AMBIENT_COOKIE
    const ctx = await mountRegistry()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(PeerRemote, transportConfig(peer.baseUrl))

    await expect(ctx.peers.listSessions(undefined)).resolves.toEqual([])

    expect(peer.cookies).toEqual([AMBIENT_COOKIE])
  })

  it('treats an empty stored value as absent and falls back to the environment', async () => {
    const peer = await fakePeer()
    process.env[COOKIE_ENV] = AMBIENT_COOKIE
    const ctx = await mountRegistry()
    await ctx.plugin(EmptyCredentials)
    await ctx.plugin(PeerRemote, transportConfig(peer.baseUrl))

    await expect(ctx.peers.listSessions(undefined)).resolves.toEqual([])

    expect(peer.cookies).toEqual([AMBIENT_COOKIE])
  })

  it('fails a peer operation when no credential resolves, naming the peer and reference', async () => {
    const ctx = await mountRegistry()
    await ctx.plugin(PeerRemote, transportConfig('http://peer.test'))

    Reflect.deleteProperty(process.env, COOKIE_ENV)
    const missing = ctx.peers.listSessions(undefined)
    await expect(missing).rejects.toBeInstanceOf(RemotePeerError)
    await expect(missing).rejects.toThrow(
      `peer "plugin-peer" has no credential for "${COOKIE_ENV}"; store the browser-session cookie there`,
    )

    process.env[COOKIE_ENV] = ''
    await expect(ctx.peers.listSessions(undefined)).rejects.toThrow(
      `peer "plugin-peer" has no credential for "${COOKIE_ENV}"; store the browser-session cookie there`,
    )
  })
})
