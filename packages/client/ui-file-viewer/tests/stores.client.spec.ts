// @vitest-environment jsdom
/** createFileViewerStore unit account: init shape and the write actions (file, render mode, clear). */
import { describe, expect, it } from 'vitest'
import { createFileViewerStore } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/stores.ts'
import type { ActiveFile } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/stores.ts'

function readyFile(over: Partial<ActiveFile> = {}): ActiveFile {
  return {
    path: '/a/b.ts', status: 'ready', content: 'const x = 1\n', size: 12, truncated: false, binary: false, lang: 'ts',
    ...over,
  }
}

describe('createFileViewerStore', () => {
  it('initializes with no active file in the source view', () => {
    const { store } = createFileViewerStore().create()
    expect(store.getSnapshot()).toEqual({ activeFile: null, renderMode: 'source' })
  })

  it('setFile writes one file and defaults the mode to source; clear resets both', () => {
    const { store, actions } = createFileViewerStore().create()
    const file = readyFile()
    actions.setFile(file)
    expect(store.getSnapshot().activeFile).toBe(file)
    expect(store.getSnapshot().renderMode).toBe('source')
    actions.setRenderMode('rendered')
    expect(store.getSnapshot().renderMode).toBe('rendered')
    actions.clear()
    expect(store.getSnapshot().activeFile).toBeNull()
    expect(store.getSnapshot().renderMode).toBe('source')
  })

  it('setFile on a non-Markdown file resets a rendered drawer to the source view', () => {
    const { store, actions } = createFileViewerStore().create()
    actions.setFile(readyFile({ lang: 'md' }), true)
    actions.setRenderMode('rendered')
    expect(store.getSnapshot().renderMode).toBe('rendered')
    actions.setFile(readyFile())
    expect(store.getSnapshot().renderMode).toBe('source')
  })

  it('setFile with markdownCapable preserves an already-rendered drawer', () => {
    const { store, actions } = createFileViewerStore().create()
    actions.setFile(readyFile({ lang: 'md' }), true)
    actions.setRenderMode('rendered')
    // Re-opening (or refolding) the same Markdown document keeps the reader.
    actions.setFile(readyFile({ lang: 'md' }), true)
    expect(store.getSnapshot().renderMode).toBe('rendered')
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createFileViewerStore().create()
    const b = createFileViewerStore().create()
    a.actions.setFile(readyFile())
    expect(b.store.getSnapshot().activeFile).toBeNull()
  })
})
