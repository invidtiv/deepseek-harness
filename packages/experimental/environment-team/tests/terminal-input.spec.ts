import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TerminalInput } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { TerminalInputRoutes, type TerminalRouteOwner } from '../src/terminal-input.ts'
import type { EnvironmentTerminalAttachmentId } from '../src/interaction-types.ts'

const owner: TerminalRouteOwner = {
  peer: brandString<TerminalRouteOwner['peer']>('caller'),
  sessionId: brandString<TerminalRouteOwner['sessionId']>('session'),
  terminalId: brandString<TerminalRouteOwner['terminalId']>('terminal'),
}
const attachment = brandString<EnvironmentTerminalAttachmentId>('viewer')

it('numbers commands per attachment and settles each on its acknowledgement', async () => {
  const routes = new TerminalInputRoutes()
  const route = routes.open(attachment, owner)
  const input = route.input()[Symbol.asyncIterator]()
  const write = routes.send(attachment, owner, { type: 'write', data: 'ls\r' }, AbortSignal.timeout(5_000))
  const resize = routes.send(attachment, owner, { type: 'resize', cols: 100, rows: 40 }, AbortSignal.timeout(5_000))
  const received: TerminalInput[] = [(await input.next()).value as TerminalInput, (await input.next()).value as TerminalInput]
  expect(received).toEqual([{ type: 'write', sequence: 1, data: 'ls\r' }, { type: 'resize', sequence: 2, cols: 100, rows: 40 }])
  route.acknowledge({ type: 'ack', sequence: 2, refusal: 'read-only' })
  route.acknowledge({ type: 'ack', sequence: 1 })
  await expect(write).resolves.toBeUndefined()
  await expect(resize).rejects.toThrow('Terminal input was refused: read-only')
  routes.release(attachment, route)
})

it('rejects commands from another caller, Session or terminal without queueing them', async () => {
  const routes = new TerminalInputRoutes()
  const route = routes.open(attachment, owner)
  for (const other of [{ ...owner, peer: brandString<TerminalRouteOwner['peer']>('other') }, { ...owner, sessionId: brandString<TerminalRouteOwner['sessionId']>('other') }, { ...owner, terminalId: brandString<TerminalRouteOwner['terminalId']>('other') }]) {
    await expect(routes.send(attachment, other, { type: 'write', data: 'x' }, AbortSignal.timeout(5_000))).rejects.toThrow('not connected')
  }
  await expect(routes.send(brandString<EnvironmentTerminalAttachmentId>('missing'), owner, { type: 'write', data: 'x' }, AbortSignal.timeout(5_000))).rejects.toThrow('not connected')
  routes.release(attachment, route)
  const input = route.input()[Symbol.asyncIterator]()
  await expect(input.next()).resolves.toEqual({ done: true, value: undefined })
})

it('refuses a reused identity and ends the uplink and unacknowledged commands on release', async () => {
  const routes = new TerminalInputRoutes()
  const route = routes.open(attachment, owner)
  expect(() => routes.open(attachment, owner)).toThrow('already in use')
  const input = route.input()[Symbol.asyncIterator]()
  const pending = routes.send(attachment, owner, { type: 'write', data: 'x' }, AbortSignal.timeout(5_000))
  await input.next()
  routes.release(attachment, route)
  await expect(pending).rejects.toThrow('Terminal attachment ended')
  await expect(input.next()).resolves.toEqual({ done: true, value: undefined })
  await expect(routes.send(attachment, owner, { type: 'write', data: 'y' }, AbortSignal.timeout(5_000))).rejects.toThrow('not connected')
  expect(routes.open(attachment, owner)).not.toBe(route)
})

it('stops waiting when the caller aborts after queueing', async () => {
  const routes = new TerminalInputRoutes()
  const route = routes.open(attachment, owner)
  const abort = new AbortController()
  const pending = routes.send(attachment, owner, { type: 'write', data: 'x' }, abort.signal)
  abort.abort(new Error('caller left'))
  await expect(pending).rejects.toThrow('caller left')
  route.acknowledge({ type: 'ack', sequence: 1 })
  routes.release(attachment, route)
})
