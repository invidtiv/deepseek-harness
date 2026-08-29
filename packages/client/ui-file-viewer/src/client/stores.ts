/**
 * The file-viewer entry's transient store: the single active file's identity,
 * fetch lifecycle, and content, plus the Markdown drawer's render mode. Root-
 * scoped (one drawer, one active file) and written only through the declared
 * actions — the service's async fetch writes `setFile` transitions and resets
 * the mode to the source default per file, the toggle flips it for a Markdown
 * document, and the close button clears. Module level exports the factory only
 * (no module-scoped handle).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/**
 * How the drawer presents a ready text file. `source` is the line-numbered
 * highlighted source; `rendered` is available only when the active file is a
 * `md`/`markdown` document (`markdownCapable`) and draws the GFM/KaTeX
 * reader. A non-Markdown file never renders the toggle, so the flag stays at
 * its source default.
 */
export type FileRenderMode = 'source' | 'rendered'

/**
 * One file the drawer shows. `status` discriminates the lifecycle:
 * `loading` while the Host read is in flight, `ready` with decoded text (or a
 * `binary` refusal), and `error` with a user-facing message.
 */
export interface ActiveFile {
  /** Absolute path being shown. */
  path: string
  status: 'loading' | 'ready' | 'error'
  /** Decoded text; empty while loading, on error, or for a binary file. */
  content: string
  /** Byte size of the file on disk. */
  size: number
  /** True when the Host returned a truncated prefix. */
  truncated: boolean
  /** True when the file is not valid text. */
  binary: boolean
  /** Syntax-highlighting language hint (extension-derived); undefined = plain text. */
  lang: string | undefined
}

/** File-viewer store state. */
type FileViewerState = { activeFile: ActiveFile | null; renderMode: FileRenderMode }

/** Annotation twin of the actions literal (the export needs a declared return type). */
type FileViewerActions = {
  setFile: (draft: FileViewerState, file: ActiveFile, markdownCapable?: boolean) => void
  setRenderMode: (draft: FileViewerState, mode: FileRenderMode) => void
  clear: (draft: FileViewerState) => void
}

/**
 * Create the file-viewer store handle. Read = `useStore`; write = `actions.*`
 * only, so the transitions (set one file + its capability, flip the render
 * mode, clear) are the complete mutation surface the service and toggle share.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createFileViewerStore(): EngineStoreHandle<FileViewerState, FileViewerActions> {
  return defineStore({
    init: (): FileViewerState => ({ activeFile: null, renderMode: 'source' }),
    actions: {
      // markdownCapable defaults to false, so the open transition also resets
      // a Markdown drawer back to the source view for the next file.
      setFile: (d, file: ActiveFile, markdownCapable = false) => {
        d.activeFile = file
        d.renderMode = markdownCapable ? d.renderMode : 'source'
      },
      setRenderMode: (d, mode: FileRenderMode) => { d.renderMode = mode },
      clear: (d) => {
        d.activeFile = null
        d.renderMode = 'source'
      },
    },
  })
}
