/** File-explorer slot registration, inject face routing, and disposal proof. */
// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { FileListing } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-file-explorer/client'
import type { FileExplorerInjected } from '@deepseek-ai/dsh-client-ui-file-explorer/client'

const rootListing: FileListing = {
  path: '/repo',
  entries: [
    { name: 'src', path: '/repo/src', kind: 'directory', hidden: false },
    { name: 'package.json', path: '/repo/package.json', kind: 'file', hidden: false },
  ],
  truncated: false,
}

async function bench(options?: { declare?: boolean; fileViewer?: { open: (path: string) => void } }) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const layout = { toggleExplorer: vi.fn() }
  const workspaces = {
    listFiles: vi.fn().mockResolvedValue(rootListing),
  }
  const openWorkspacePath = vi.fn().mockResolvedValue({ ok: true as const, value: { opened: true as const } })
  if (options?.fileViewer !== undefined) ctx.provide('fileViewer', options.fileViewer)
  ctx.provide('layout', layout)
  ctx.provide('workspaces', workspaces as never)
  Object.assign(new TestRemote(ctx), { session: { openWorkspacePath } })
  ctx.provide('remote.session', { openWorkspacePath } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  if (options?.declare ?? true) {
    slots.register(
      { name: 'root', children: { 'explorer': { kind: 'single', scope: 'root' } } } as never,
      () => null,
    )
  }
  return { ctx, slots, layout, workspaces, openWorkspacePath }
}

describe('ui-file-explorer apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'workspaces', 'locale', 'remote', 'remote.session'])
  })

  it('registers the tree into the layout-owned explorer slot with its dictionary', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('explorer')).toHaveLength(1)
    expect(b.slots.entries('explorer')[0]!.locale).toBe('fileExplorer')
  })

  it('fails when no live owner declared the explorer slot', async () => {
    const b = await bench({ declare: false })
    await expect(b.ctx.plugin({ inject: [...inject], apply })).rejects.toThrow(/not declared/)
  })

  it('the inject face exposes toggle, openFile, and listFiles with viewer-preferring open routing', async () => {
    const b = await bench({ fileViewer: { open: vi.fn() } })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = (b.slots.entries('explorer')[0]!.inject as unknown as () => FileExplorerInjected)()
    expect(Object.keys(injected)).toEqual(['toggle', 'openFile', 'listFiles'])

    injected.toggle()
    expect(b.layout.toggleExplorer).toHaveBeenCalledTimes(1)

    injected.openFile('/repo/package.json')
    expect((b.ctx.get('fileViewer') as { open: (path: string) => void }).open).toHaveBeenCalledWith('/repo/package.json')
    expect(b.openWorkspacePath).not.toHaveBeenCalled()

    const listing = await injected.listFiles('/repo')
    expect(b.workspaces.listFiles).toHaveBeenCalledWith('/repo', undefined)
    expect(listing.path).toBe('/repo')
  })

  it('open falls back to the Host opener when no file-viewer is composed in', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = (b.slots.entries('explorer')[0]!.inject as unknown as () => FileExplorerInjected)()
    injected.openFile('/repo/readme.md')
    expect(b.openWorkspacePath).toHaveBeenCalledWith({ path: '/repo/readme.md' })
  })

  it('removes the entry on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('explorer')).toHaveLength(0)
  })
})
