/** File-viewer slot registration, service provision, and disposal proof. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-file-viewer/client'
import type { FileViewerInjected } from '@deepseek-ai/dsh-client-ui-file-viewer/client'

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const layout = { openFileViewer: vi.fn(), closeFileViewer: vi.fn() }
  const workspaces = { readFile: vi.fn().mockResolvedValue({ path: '/f', content: 'x', size: 1, truncated: false, binary: false }) }
  ctx.provide('layout', layout)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    slots.register(
      { name: 'root', children: { 'fileViewer': { kind: 'single', scope: 'root' } } } as never,
      () => null,
    )
  }
  return { ctx, slots, layout, workspaces }
}

describe('ui-file-viewer apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'workspaces', 'locale'])
  })

  it('provides ctx.fileViewer and registers the drawer into the fileViewer slot', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.ctx.get('fileViewer')).toBeDefined()
    expect(b.slots.entries('fileViewer')).toHaveLength(1)
    expect(b.slots.entries('fileViewer')[0]!.locale).toBe('fileViewer')
  })

  it('the inject face exposes close, which clears and closes the column', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const actions = { setFile: vi.fn(), clear: vi.fn() }
    const injected = (b.slots.entries('fileViewer')[0]!.inject as unknown as (actions: never) => FileViewerInjected)(actions as never)
    expect(Object.keys(injected)).toEqual(['close'])
    injected.close()
    expect(actions.clear).toHaveBeenCalledTimes(1)
    expect(b.layout.closeFileViewer).toHaveBeenCalledTimes(1)
  })

  it('the service open routes a file read through the store and the column', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const actions = { setFile: vi.fn(), clear: vi.fn() }
    // Wire the store actions through the inject hook first (the service's open
    // requires them), then open through the provided service.
    ;(b.slots.entries('fileViewer')[0]!.inject as unknown as (actions: never) => FileViewerInjected)(actions as never)
    ;(b.ctx.get('fileViewer') as { open: (path: string) => void }).open('/repo/a.ts')
    expect(b.layout.openFileViewer).toHaveBeenCalledTimes(1)
    expect(actions.setFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/repo/a.ts', status: 'loading' }), false)
    await vi.waitFor(() => {
      expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }), false)
    })
  })

  it('fails when no live owner declared the fileViewer slot', async () => {
    const b = await bench(false)
    await expect(b.ctx.plugin({ inject: [...inject], apply })).rejects.toThrow(/not declared/)
  })

  it('removes the entry on teardown and disposes the service', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('fileViewer')).toHaveLength(0)
    expect(b.ctx.get('fileViewer')).toBeUndefined()
  })
})
