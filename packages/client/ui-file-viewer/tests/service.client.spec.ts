/**
 * FileViewerController behavior: open/close transitions, the store-action
 * delegation contract, and the request-sequence guard against stale reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { FileViewerController } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/service.ts'
import type { FileViewerActions } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/service.ts'
import type { FileContents } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'

function fakeActions(): FileViewerActions {
  return { setFile: vi.fn(), setRenderMode: vi.fn(), clear: vi.fn() }
}

function fakeLayout(): ILayout {
  return {
    toggleSidebar: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    openFileViewer: vi.fn(),
    closeFileViewer: vi.fn(),
    toggleExplorer: vi.fn(),
  }
}

/** Layout double whose column-open/close mocks are held outside the ILayout face for direct assertion. */
function fakeLayoutSpied(): { layout: ILayout; openFileViewer: ReturnType<typeof vi.fn>; closeFileViewer: ReturnType<typeof vi.fn> } {
  const openFileViewer = vi.fn()
  const closeFileViewer = vi.fn()
  return { layout: { ...fakeLayout(), openFileViewer, closeFileViewer }, openFileViewer, closeFileViewer }
}

function contents(over: Partial<FileContents> = {}): FileContents {
  return { path: '/a/b.ts', content: 'const x = 1\n', size: 12, truncated: false, binary: false, ...over }
}

describe('FileViewerController', () => {
  it('fails loud before the entry wired its actions', () => {
    const controller = new FileViewerController({ readFile: vi.fn() } as never, fakeLayout())
    expect(() => { controller.open('/a') }).toThrow(/actions not wired/)
    expect(() => { controller.close() }).toThrow(/actions not wired/)
  })

  it('open writes loading, opens the column, then folds a successful read into ready', async () => {
    const readFile = vi.fn().mockResolvedValue(contents())
    const { layout, openFileViewer } = fakeLayoutSpied()
    const controller = new FileViewerController({ readFile } as never, layout)
    const actions = fakeActions()
    controller.attach(actions)

    controller.open('/a/b.ts')

    expect(openFileViewer).toHaveBeenCalledTimes(1)
    expect(actions.setFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/a/b.ts', status: 'loading', lang: 'ts' }), false)
    await vi.waitFor(() => {
      expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready', content: 'const x = 1\n' }), false)
    })
  })

  it('open folds a failed read into error without throwing', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('boom'))
    const controller = new FileViewerController({ readFile } as never, fakeLayout())
    const actions = fakeActions()
    controller.attach(actions)

    controller.open('/missing.txt')

    await vi.waitFor(() => {
      expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/missing.txt', status: 'error' }), false)
    })
  })

  it('a newer open drops the older in-flight read (request-sequence guard)', async () => {
    const resolvers: Array<(c: FileContents) => void> = []
    const readFile = vi.fn().mockImplementation(() => new Promise<FileContents>((resolve) => {
      resolvers.push(resolve)
    }))
    const controller = new FileViewerController({ readFile } as never, fakeLayout())
    const actions = fakeActions()
    controller.attach(actions)

    controller.open('/first.ts')
    controller.open('/second.ts')

    // Resolve the stale first read; the guard must drop its ready write.
    resolvers[0]!(contents({ path: '/first.ts' }))
    await Promise.resolve()
    expect(actions.setFile).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/first.ts', status: 'ready' }))
    // The second read is still in flight: the last write is its loading state.
    expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/second.ts', status: 'loading' }), false)
  })

  it('a close during an in-flight failed read drops the error write', async () => {
    const rejecters: Array<(e: unknown) => void> = []
    const readFile = vi.fn().mockImplementation(() => new Promise<FileContents>((_resolve, reject) => {
      rejecters.push(reject)
    }))
    const controller = new FileViewerController({ readFile } as never, fakeLayout())
    const actions = fakeActions()
    controller.attach(actions)

    controller.open('/a.ts')
    controller.close() // bumps the sequence, invalidating the pending read
    rejecters[0]!(new Error('boom'))
    await Promise.resolve()
    expect(actions.setFile).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
  })

  it('close clears the file, closes the column, and invalidates the in-flight read', async () => {
    const readFile = vi.fn().mockResolvedValue(contents())
    const { layout, closeFileViewer } = fakeLayoutSpied()
    const controller = new FileViewerController({ readFile } as never, layout)
    const actions = fakeActions()
    controller.attach(actions)

    controller.open('/a/b.ts')
    controller.close()

    expect(actions.clear).toHaveBeenCalledTimes(1)
    expect(closeFileViewer).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      // The read resolved after close, but the guard drops its ready write.
      expect(actions.setFile).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }))
    })
  })

  it('a Markdown file enables the reader only when re-opened; other files never do', async () => {
    const readFile = vi.fn().mockResolvedValue(contents())
    const controller = new FileViewerController({ readFile } as never, fakeLayout())
    const actions = fakeActions()
    controller.attach(actions)

    // First open of a Markdown document: source view (capability false)…
    controller.open('/doc.md')
    expect(actions.setFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/doc.md' }), false)
    await vi.waitFor(() => {
      expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/doc.md', status: 'ready' }), false)
    })

    // …re-opening the same document restores whichever mode survived.
    controller.open('/doc.md')
    expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/doc.md' }), true)

    // A different Markdown file and a non-Markdown file start at the source view.
    controller.open('/other.md')
    expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/other.md' }), false)
    controller.open('/code.ts')
    expect(actions.setFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/code.ts' }), false)
  })
})
