/**
 * File-explorer plugin, browser half: registers the project file tree into
 * the layout-owned `explorer` column. Directory listings arrive through the
 * workspaces face (`workspace.listFiles`); file clicks route through the optional
 * `ctx.fileViewer` drawer when composed in, with the Host opener fallback
 * otherwise — the same routing contract ui-conversation applies.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls ui-layout's `ctx.layout` Context merge and the `explorer`
// SlotMap entry (the declaration this package registers into).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the optional `ctx.fileViewer` Context merge this package reads.
import type {} from '@deepseek-ai/dsh-client-ui-file-viewer/client'
import { FileExplorerRoot, type FileExplorerInjected } from './FileExplorerRoot.tsx'
import { en, NS, zh, type FileExplorerKey } from './locales.ts'

export type { FileExplorerInjected, FileExplorerProps } from './FileExplorerRoot.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Explorer column copy. */
    fileExplorer: FileExplorerKey
  }
}

/** Services required by the file-explorer plugin. */
export const inject = ['slots', 'layout', 'workspaces', 'locale', 'remote', 'remote.session']

/**
 * Client plugin body: register the file tree into the layout-owned
 * `explorer` slot with dictionary support.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-file-explorer: dictionaries')

  ctx.effect(() => ctx.slots.register({
    name: 'explorer',
    locale: NS,
    inject: (): FileExplorerInjected => ({
      toggle: () => { ctx.layout.toggleExplorer() },
      openFile: (path: string): void => {
        // Optional read: composed-out deployments keep the conversation's
        // Host-opener fallback instead of the drawer. A transport rejection
        // (connection gone mid-open) only drops this one fire-and-forget open.
        const viewer = ctx.get('fileViewer')
        if (viewer !== undefined) { viewer.open(path); return }
        void ctx.remote.session.openWorkspacePath({ path }).catch(() => undefined)
      },
      listFiles: (path?: string, signal?: AbortSignal) => ctx.workspaces.listFiles(path, signal),
    }),
  }, FileExplorerRoot), 'ui-file-explorer: column registration')
}
