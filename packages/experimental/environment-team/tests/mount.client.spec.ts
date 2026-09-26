/** Experimental configuration registration owns its Remote namespace and shell feedback. */
import { afterEach, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { PageActions } from '../src/client/Page.tsx'
import type { NoticeFace } from '../src/client/Notice.tsx'
import type { EnvironmentsActions } from '../src/client/Environments.tsx'
import { brandString } from '@deepseek-ai/dsh-brand'
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
function assertBrowser(value: Record<string, unknown>): asserts value is Record<string, unknown> & EnvironmentsActions {
  assert(typeof value.environments === 'function' && typeof value.workspace === 'function' && typeof value.notify === 'function')
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
  const environments = vi.fn().mockResolvedValue({ ok: true, value: [] })
  const workspace = vi.fn().mockResolvedValue({ ok: true, value: { kind: 'catalog', roots: [], workspaces: [], truncated: false } })
  ctx.provide('remote.environmentTeamSettings', { read, save, environments, workspace })
  ctx.provide('remote.credentials', { set })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
  } }, (_props: PropsRenderSlots<'plugins.bundle.config' | 'shell.overlay' | 'main' | 'sidebar.panellist'>) => null)
  return { ctx, unmount, read, save, set, environments, workspace }
}

it('withdraws its configuration page and feedback when the Client plugin is disposed', async () => {
  const b = await fixture()
  const dispose = await apply(b.ctx)
  expect(resolveSlotLabel(b.ctx.slots.entries('sidebar.panellist')[0]!.options.label)).toBe('Environments')
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
  const browser = b.ctx.slots.entries('main')[0]!.inject!()
  assertBrowser(browser)
  expect(await browser.environments()).toEqual([])
  const id = brandString<Parameters<EnvironmentsActions['workspace']>[0]>('11111111-1111-4111-8111-111111111111')
  expect(await browser.workspace(id, { action: 'catalog' })).toMatchObject({ kind: 'catalog' })
  browser.notify('workspaceSaved')
  expect(notice.hooks.environmentNotice.getSnapshot().kind).toBe('workspaceSaved')
  b.environments.mockResolvedValueOnce(failure)
  await expect(browser.environments()).rejects.toThrow('unavailable')
  b.workspace.mockResolvedValueOnce(failure)
  await expect(browser.workspace(id, { action: 'catalog' })).rejects.toThrow('unavailable')
  b.read.mockResolvedValueOnce(failure)
  await expect(actions.read()).rejects.toThrow('unavailable')
  b.save.mockResolvedValueOnce(failure)
  await expect(actions.save(value)).rejects.toThrow('unavailable')
  b.set.mockResolvedValueOnce(failure)
  await expect(actions.credential('DSH_PAIR', 'secret')).rejects.toThrow('unavailable')
  await dispose()
  expect(b.ctx.slots.entries('plugins.bundle.config')).toHaveLength(0)
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(b.ctx.slots.entries('main')).toHaveLength(0)
  expect(b.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
  expect(b.unmount).toHaveBeenCalledOnce()
})

it('withdraws the Remote contribution if UI registration fails', async () => {
  const b = await fixture()
  vi.spyOn(b.ctx.locale, 'register').mockImplementationOnce(() => { throw new Error('registration failed') })
  await expect(apply(b.ctx)).rejects.toThrow('registration failed')
  expect(b.unmount).toHaveBeenCalledOnce()
})
