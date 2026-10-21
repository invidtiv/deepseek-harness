/** Revision-checked configuration commits, credential staging cleanup, and queued writers. */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { pairingHost } from './pairing-host.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const host = () => pairingHost((close) => { closes.push(close) })
const secret = () => randomBytes(32).toString('base64url')

async function withPeer() {
  const fixture = await host()
  const current = await fixture.controller.read()
  const peerId = brandString<typeof current.environmentId>(randomUUID())
  const saved = await fixture.controller.saveWithCredentials(
    { ...current, config: { ...current.config, peers: [{ environmentId: peerId, url: 'https://peer.example', tokenEnv: 'UNUSED', workspaces: [] }] } },
    [{ environmentId: peerId, secret: secret() }],
  )
  return { ...fixture, peerId, saved }
}

it('resolves the raw Loader configuration while the active fiber has no resolved configuration', async () => {
  const { ctx, controller } = await host()
  const before = await controller.read()
  const entry = ctx.configEditor.entries().find(item => item.options.id === 'environment-team')
  const fiber = entry?.fiber
  if (!fiber) throw new Error('Missing environment-team fiber')
  const resolved: unknown = fiber.config
  fiber.config = undefined
  try { expect(await controller.read()).toEqual(before) } finally { fiber.config = resolved }
})

it('rejects a stale environment identity and inconsistent credential changes before staging secrets', async () => {
  const { ctx, controller, peerId, saved } = await withPeer()
  const set = vi.spyOn(ctx.credentials, 'set')
  await expect(controller.save({ ...saved, environmentId: brandString<typeof saved.environmentId>(randomUUID()) })).rejects.toThrow('environment identity mismatch')
  await expect(controller.saveWithCredentials(saved, [{ environmentId: peerId, secret: secret() }, { environmentId: peerId, secret: secret() }])).rejects.toThrow('Duplicate peer credential change')
  await expect(controller.saveWithCredentials(saved, [{ environmentId: brandString<typeof saved.environmentId>(randomUUID()), secret: secret() }])).rejects.toThrow('no configured peer')
  expect(set).not.toHaveBeenCalled()
  expect(await controller.read()).toEqual(saved)
})

it('discards staged credentials when the profile revision changes during the edit', async () => {
  const { ctx, controller, peerId, saved } = await withPeer()
  const set = vi.spyOn(ctx.credentials, 'set')
  const unset = vi.spyOn(ctx.credentials, 'unset')
  vi.spyOn(ctx.configEditor, 'edit').mockImplementation(async (_entry, update) => {
    update({ changedElsewhere: true }, {})
  })
  await expect(controller.saveWithCredentials(saved, [{ environmentId: peerId, secret: secret() }])).rejects.toThrow('Configuration changed')
  expect(set).toHaveBeenCalledTimes(1)
  expect(unset).toHaveBeenCalledTimes(1)
  expect(unset).toHaveBeenCalledWith(set.mock.calls[0]?.[0])
  expect(await controller.read()).toEqual(saved)
})

it('reports staged credential cleanup failures together with the original save failure', async () => {
  const { ctx, controller, peerId, saved } = await withPeer()
  vi.spyOn(ctx.configEditor, 'edit').mockRejectedValue(new Error('profile conflict'))
  vi.spyOn(ctx.credentials, 'unset').mockRejectedValue(new Error('credential store offline'))
  await expect(controller.saveWithCredentials(saved, [{ environmentId: peerId, secret: secret() }])).rejects.toMatchObject({
    name: 'AggregateError', errors: [expect.objectContaining({ message: 'profile conflict' }), expect.objectContaining({ message: 'credential store offline' })],
  })
})

it('serializes concurrent writers of one state directory so the later stale writer is rejected', async () => {
  const { controller } = await host()
  const current = await controller.read()
  const results = await Promise.allSettled([
    controller.save({ ...current, config: { ...current.config, label: 'first writer' } }),
    controller.save({ ...current, config: { ...current.config, label: 'second writer' } }),
  ])
  expect(results.map(item => item.status)).toEqual(['fulfilled', 'rejected'])
  expect((await controller.read()).config.label).toBe('first writer')
})
