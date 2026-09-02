/**
 * FileViewerController: the cross-plugin face behind `ctx.fileViewer`. It
 * bridges the file-viewer entry's store (active file) to the layout panel
 * (open/close) and the Host read capability (`ctx.workspaces.readFile`).
 * Opening writes a `loading` transition, opens the layout column, then folds
 * the Host result into `ready`/`error` — guarded by a request sequence so a
 * rapid re-open or a close during flight never lets a stale read overwrite the
 * current file.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createFileViewerStore } from './stores.ts'
import { isMarkdownLang, langFromPath } from './langFromPath.ts'

/** The file-viewer store's bound action set (framework-baked, draft params peeled). */
export type FileViewerActions = BoundActions<ReturnType<typeof createFileViewerStore>>

/**
 * The outward file-viewer face (`ctx.fileViewer`): the two transitions other
 * plugins trigger — open one file, close the drawer. `attach` stays on the
 * concrete class (entry assembly only), mirroring LayoutController.
 */
export interface IFileViewer {
  /**
   * Open the drawer on one absolute path, fetching its text through the Host.
   * A missing/unreadable path lands in the drawer's error state rather than
   * throwing.
   * @param path - absolute or host-resolvable path (the caller resolves relative paths).
   */
  open(path: string): void
  /** Close the drawer and clear the active file. */
  close(): void
}

/** Cross-plugin file-viewer face (ctx.fileViewer). */
export class FileViewerController implements IFileViewer {
  #actions: FileViewerActions | undefined
  /** Monotonic request guard: only the latest open may publish a result. */
  #requestSeq = 0
  /** Active or last-opened Markdown path; re-opening it restores its render mode. */
  #markdownPath: string | undefined = undefined

  /**
   * @param workspaces - the runtime workspace face whose `readFile` fetches text.
   * @param layout - the layout face whose `openFileViewer`/`closeFileViewer` toggle the column.
   */
  constructor(
    private readonly workspaces: IWorkspaces,
    private readonly layout: ILayout,
  ) {}

  /**
   * Adopt the entry's bound store actions. Called from the registration's
   * inject hook; a re-register overwrites the stale set.
   * @param actions - bound actions of the file-viewer store instance.
   */
  attach(actions: FileViewerActions): void {
    this.#actions = actions
  }

  open(path: string): void {
    const actions = this.#require()
    const request = ++this.#requestSeq
    const lang = langFromPath(path)
    // Markdown documents unlock the drawer's reader mode. The mode itself
    // survives only within the same path: `open` resets it to the source view
    // unless the same Markdown file is fetched again, and close clears it
    // with everything else.
    const markdownCapable = path === this.#markdownPath
    this.#markdownPath = isMarkdownLang(lang) ? path : undefined
    this.layout.openFileViewer()
    actions.setFile({ path, status: 'loading', content: '', size: 0, truncated: false, binary: false, lang }, markdownCapable)
    void this.workspaces.readFile(path).then(
      (contents) => {
        if (request !== this.#requestSeq) return
        actions.setFile({
          path,
          status: 'ready',
          content: contents.content,
          size: contents.size,
          truncated: contents.truncated,
          binary: contents.binary,
          lang,
        }, markdownCapable)
      },
      (_error: unknown) => {
        if (request !== this.#requestSeq) return
        actions.setFile({
          path,
          status: 'error',
          content: '',
          size: 0,
          truncated: false,
          binary: false,
          lang,
        }, markdownCapable)
      },
    )
  }

  close(): void {
    this.#requestSeq += 1
    this.#require().clear()
    this.layout.closeFileViewer()
  }

  #require(): FileViewerActions {
    // Callers are UI gestures, which cannot fire before the entry rendered
    // (the inject hook runs in its first render) — reaching this unwired is a
    // boot-order bug, not a race to tolerate.
    if (this.#actions === undefined) throw new Error('fileViewer: store actions not wired (entry not mounted)')
    return this.#actions
  }
}
