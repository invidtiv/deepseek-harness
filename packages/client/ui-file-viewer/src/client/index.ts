/**
 * File-viewer plugin, browser half: provides `ctx.fileViewer` (open/close) and
 * registers the drawer into the layout-owned `fileViewer` column. Opening a
 * file writes the loading transition, opens the layout column, and folds the
 * Host `readFile` result into ready/error; the drawer's close button clears
 * and closes. The service is optional to consumers — ui-conversation reaches
 * it via `ctx.get('fileViewer')` and falls back to the Host opener when this
 * plugin is composed out.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls ui-layout's `ctx.layout` Context merge and the `fileViewer`
// SlotMap entry (the declaration this package registers into).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { FileViewer, type FileViewerInjected } from './FileViewer.tsx'
import { createFileViewerStore } from './stores.ts'
import { FileViewerController, type FileViewerActions, type IFileViewer } from './service.ts'
import { en, NS, zh, type FileViewerKey } from './locales.ts'

export { FileViewer, type FileViewerInjected } from './FileViewer.tsx'
export type { IFileViewer } from './service.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-viewer drawer copy. */
    fileViewer: FileViewerKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** File-viewer face; reach via ctx.get — optional (composed-out = Host opener fallback). */
    fileViewer: IFileViewer
  }
}

/** Services required by the file-viewer plugin. */
export const inject = ['slots', 'layout', 'workspaces', 'locale']

/**
 * Client plugin body: provide `ctx.fileViewer`, then register the drawer.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-file-viewer: dictionaries')

  // Apply-time construction keeps the controller and store identity bound to
  // this fiber; the controller's async read writes through the entry's bound
  // actions, which the inject hook attaches on first render.
  const controller = new FileViewerController(ctx.workspaces, ctx.layout)
  const store = createFileViewerStore()

  ctx.provide('fileViewer', controller)

  ctx.effect(() => ctx.slots.register({
    name: 'fileViewer',
    locale: NS,
    store,
    inject: (actions: FileViewerActions): FileViewerInjected => {
      controller.attach(actions)
      return { close: () => { controller.close() } }
    },
  }, FileViewer), 'ui-file-viewer: drawer registration')
}
