/** Route retirement and incomplete uploads close before destination Session admission. */
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { pairedSessionHosts } from './session-peer-host.ts'
import { EnvironmentTeams } from '../src/runtime.ts'
import { PeerTransport } from '../src/transport.ts'
import { handlePeerSession } from '../src/peer-stream.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function admission(aborted: boolean) {
  const opening = vi.spyOn(EnvironmentTeams, 'open')
  const { destination, token } = await pairedSessionHosts((close) => { closes.push(close) }, { requestTimeoutMs: 100 })
  const result = opening.mock.results.at(-1)
  if (result?.type !== 'return') throw new Error('Destination runtime did not open')
  const runtime = await result.value
  const transport = new PeerTransport(destination.id, destination.config, destination.ctx.credentials)
  const owner = new AbortController()
  if (aborted) owner.abort()
  const handled = Promise.withResolvers<undefined>()
  const server = createServer((request, response) => {
    void handlePeerSession(transport, runtime, destination.id, destination.config, request, response, owner.signal)
      .then(() => { handled.resolve(undefined) }, handled.reject)
  })
  closes.push(async () => {
    owner.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing admission fixture port')
  const followed = vi.spyOn(EnvironmentTeams.prototype, 'follow')
  return { port: address.port, token, handled: handled.promise, followed }
}

it('rejects a retired route before opening a destination follower', async () => {
  const fixture = await admission(true)
  await expect(fetch(`http://127.0.0.1:${fixture.port}/`, {
    method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, body: '{}',
  })).rejects.toThrow()
  await fixture.handled
  expect(fixture.followed).not.toHaveBeenCalled()
})

it('closes an authenticated incomplete upload at its configured request deadline', async () => {
  const fixture = await admission(false)
  const socket = createConnection({ host: '127.0.0.1', port: fixture.port })
  closes.push(async () => { socket.destroy() })
  socket.on('error', (_closedUpload) => { /* The server terminates the incomplete upload. */ })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  socket.write(`POST / HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${fixture.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`)
  await closed
  await fixture.handled
  expect(socket.destroyed).toBe(true)
  expect(fixture.followed).not.toHaveBeenCalled()
})
