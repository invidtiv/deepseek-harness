/** Experimental configuration registration owns its Remote namespace and shell feedback. */
import { afterEach, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { PageActions } from '../src/client/Page.tsx'
import type { NoticeFace } from '../src/client/Notice.tsx'
import { apply } from '../src/client/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-environment-team/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-environment-team', descriptors: [] } }))
const roots: Context[] = []
function assertActions(value: Record<string, unknown>): asserts value is Record<string, unknown> & PageActions {
  assert(typeof value.read === 'function' && typeof value.save === 'function')
  assert(typeof value.notify === 'function' && typeof value.credential === 'function')
}
function assertNotice(value: Record<string, unknown>): asserts value is Record<string, unknown> & NoticeFace {
  assert(typeof value.dismiss === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null && 'environmentNotice' in value.hooks)
}
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })
async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution.package).toBe('@deepseek-ai/dsh-experimental-environment-team')
      return unmount
    }
  }
  new Remote()
  const read = vi.fn().mockResolvedValue({ ok: true, value: {} })
  const save = vi.fn().mockResolvedValue({ ok: true, value: {} })
  const set = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  ctx.provide('remote.environmentTeamSettings', { read, save })
  ctx.provide('remote.credentials', { set })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, (_props: PropsRenderSlots<'plugins.bundle.config' | 'shell.overlay'>) => null)
  return { ctx, unmount, read, save, set }
}

it('withdraws its configuration page and feedback when the Client plugin is disposed', async () => {
  const b = await fixture()
  const dispose = await apply(b.ctx)
  const page = b.ctx.slots.entries('plugins.bundle.config')[0]!
  const actions = page.inject!()
  assertActions(actions)
  const notice = b.ctx.slots.entries('shell.overlay')[0]!.inject!()
  assertNotice(notice)
  const value = await actions.read()
  expect(await actions.save(value)).toEqual({})
  await actions.credential('DSH_PAIR', 'secret')
  actions.notify('saved')
  expect(notice.hooks.environmentNotice.getSnapshot().kind).toBe('saved')
  notice.dismiss()
  expect(notice.hooks.environmentNotice.getSnapshot().kind).toBeNull()
  const failure = { ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) }
  b.read.mockResolvedValueOnce(failure)
  await expect(actions.read()).rejects.toThrow('unavailable')
  b.save.mockResolvedValueOnce(failure)
  await expect(actions.save(value)).rejects.toThrow('unavailable')
  b.set.mockResolvedValueOnce(failure)
  await expect(actions.credential('DSH_PAIR', 'secret')).rejects.toThrow('unavailable')
  await dispose()
  expect(b.ctx.slots.entries('plugins.bundle.config')).toHaveLength(0)
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(b.unmount).toHaveBeenCalledOnce()
})

it('withdraws the Remote contribution if UI registration fails', async () => {
  const b = await fixture()
  vi.spyOn(b.ctx.locale, 'register').mockImplementationOnce(() => { throw new Error('registration failed') })
  await expect(apply(b.ctx)).rejects.toThrow('registration failed')
  expect(b.unmount).toHaveBeenCalledOnce()
})
