/** Public pairing exchange routes and provider remounting over real HTTP and storage. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as Pairing from '../src/pairing.ts'
import { PAIRING_REDEEM_PATH, PAIRING_STATUS_PATH } from '../src/pairing-core.ts'
import { pairingDomain } from '../src/pairing-store.ts'
import type { PairingReceipt } from '../src/pairing-types.ts'
import { pairingHost } from './pairing-host.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const host = () => pairingHost((close) => { closes.push(close) })
const json = { 'content-type': 'application/json' }

it.each([
  ['origin', { origin: 'https://example.invalid' }],
  ['sec-fetch-site', { 'sec-fetch-site': 'cross-site' }],
] as const)('refuses requests that carry a browser %s header', async (_name, headers) => {
  const { url } = await host()
  for (const path of [PAIRING_REDEEM_PATH, PAIRING_STATUS_PATH]) {
    expect((await fetch(url + path, { headers })).status).toBe(403)
  }
})

it('authenticates status reads and accepts only GET for them', async () => {
  const { url } = await host()
  expect((await fetch(url + PAIRING_STATUS_PATH, { method: 'POST' })).status).toBe(405)
  expect((await fetch(url + PAIRING_STATUS_PATH)).status).toBe(401)
})

it('accepts redemption only as bounded JSON POST bodies that name a valid invitation', async () => {
  const { url, controller } = await host()
  const current = await controller.read()
  await controller.save({ ...current, config: { ...current.config, maxBytes: 2048 } })
  const redeem = (init: RequestInit) => fetch(url + PAIRING_REDEEM_PATH, init).then(response => response.status)
  expect(await redeem({})).toBe(415)
  expect(await redeem({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).toBe(415)
  expect(await redeem({ method: 'POST', headers: json, body: 'x'.repeat(4096) })).toBe(413)
  expect(await redeem({ method: 'POST', headers: json, body: '{' })).toBe(400)
  expect(await redeem({ method: 'POST', headers: json, body: '{}' })).toBe(400)
  const body = { invitationId: randomUUID(), token: 'a'.repeat(43), target: { environmentId: randomUUID(), url }, secret: 'b'.repeat(43) }
  expect(await redeem({ method: 'POST', headers: json, body: JSON.stringify(body) })).toBe(403)
})

it.each(['completes', 'fails'] as const)('closes an in-flight redemption without answering when the provider is disposed and it %s', async (ending) => {
  const { url, ctx, mounted } = await host()
  const receipt: PairingReceipt = { environmentId: brandString<PairingReceipt['environmentId']>(randomUUID()), peerId: brandString<PairingReceipt['peerId']>(randomUUID()), invitationId: brandString<PairingReceipt['invitationId']>(randomUUID()) }
  let settle: () => void = () => undefined
  const redeem = vi.spyOn(ctx.environmentPairing, 'redeem').mockImplementation(() => new Promise((resolve, reject) => {
    settle = () => { if (ending === 'completes') resolve(receipt); else reject(new Error('redemption failed')) }
  }))
  const outcome = fetch(url + PAIRING_REDEEM_PATH, { method: 'POST', headers: json, body: '{}' }).then(response => response.status, () => 'closed')
  await vi.waitFor(() => { expect(redeem).toHaveBeenCalled() })
  const disposed = (await mounted).dispose()
  expect(await outcome).toBe('closed')
  settle()
  await disposed
})

it('remounts over storage bound to the same installation and refuses storage bound to another', async () => {
  const { ctx, mounted, controller } = await host()
  await (await mounted).dispose()
  const remounted = await ctx.plugin(Pairing)
  expect(await controller.pairingList()).toEqual([])
  await remounted.dispose()
  const domain = await ctx.storageDomain.open(pairingDomain)
  await domain.global.set({ environmentId: brandString<NonNullable<ReturnType<typeof domain.global.get>['environmentId']>>(randomUUID()) })
  await domain.close()
  await expect(ctx.plugin(Pairing)).rejects.toThrow('belongs to another installation')
})
