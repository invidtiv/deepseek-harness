// @vitest-environment jsdom
/**
 * FileViewer component: the drawer's chrome (header basename + path + close),
 * metadata row, and the status/body switch (loading, error, binary, empty, and
 * the line-numbered highlighted source). The store and selector are driven
 * through the test-sanctioned engine path; `t` is a key-echoing stub so copy
 * assertions pin keys, not locales.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { FileViewer } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/FileViewer.tsx'
import type { FileViewerProps } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/FileViewer.tsx'
import { createFileViewerStore } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/stores.ts'
import type { ActiveFile } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/stores.ts'

afterEach(cleanup)

/** Test-local selector hook over the real engine instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

const t = ((key: string) => key) as FileViewerProps['t']

function mount(file: ActiveFile | null) {
  const instance = createFileViewerStore().create()
  if (file !== null) instance.actions.setFile(file)
  const close = vi.fn()
  const utils = render(<FileViewer useStore={hookOf(instance)} actions={instance.actions} close={close} t={t} />)
  return { ...utils, instance, close }
}

function readyFile(over: Partial<ActiveFile> = {}): ActiveFile {
  return {
    path: '/repo/src/a.ts', status: 'ready', content: 'const x = 1\n// note\n', size: 22, truncated: false, binary: false, lang: 'ts',
    ...over,
  }
}

function gutters(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class^="_gutter_"]')].map(cell => cell.textContent ?? '')
}

describe('FileViewer', () => {
  it('renders nothing while no file is active', () => {
    const { container } = mount(null)
    expect(container.firstElementChild).toBeNull()
  })

  it('shows the loading status and the path header', () => {
    mount({ path: '/repo/a.ts', status: 'loading', content: '', size: 0, truncated: false, binary: false, lang: 'ts' })
    expect(screen.getByText('viewer.loading')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('/repo/a.ts')).toBeTruthy()
  })

  it('shows the error status without a body', () => {
    mount({ path: '/repo/a.ts', status: 'error', content: '', size: 0, truncated: false, binary: false, lang: 'ts' })
    expect(screen.getByText('viewer.error')).toBeTruthy()
  })

  it('shows the binary refusal status', () => {
    mount(readyFile({ binary: true, content: '' }))
    expect(screen.getByText('viewer.binary')).toBeTruthy()
  })

  it('shows the empty status for a zero-line file', () => {
    mount(readyFile({ content: '' }))
    expect(screen.getByText('viewer.empty')).toBeTruthy()
  })

  it('renders the header, metadata, and line-numbered source for a ready file', () => {
    const { container } = mount(readyFile())
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('/repo/src/a.ts')).toBeTruthy()
    // Metadata: language, two lines, and the byte size.
    expect(screen.getByText('ts')).toBeTruthy()
    expect(screen.getByText(/2 viewer\.lines/)).toBeTruthy()
    expect(screen.getByText('22 viewer.unitB')).toBeTruthy()
    // Gutter numbers and the source text are present.
    expect(gutters(container)).toEqual(['1', '2'])
    expect(container.textContent).toContain('const x = 1')
    expect(container.textContent).toContain('// note')
  })

  it('the truncated flag renders the truncation note', () => {
    mount(readyFile({ truncated: true }))
    expect(screen.getByText('viewer.truncated')).toBeTruthy()
  })

  it('renders plain text without highlighting when the language is unknown', () => {
    const { container } = mount(readyFile({ lang: undefined }))
    // The no-highlight fallback label rides its dictionary key, and a
    // bare-text code body renders.
    expect(screen.getByText('viewer.plainText')).toBeTruthy()
    expect(gutters(container)).toEqual(['1', '2'])
    expect(container.textContent).toContain('const x = 1')
  })

  it('splits a source without a trailing newline into its own lines', () => {
    const { container } = mount(readyFile({ content: 'const x = 1' }))
    expect(gutters(container)).toEqual(['1'])
    expect(container.textContent).toContain('const x = 1')
  })

  it('formats the size in KB and MB units', () => {
    const kb = mount(readyFile({ size: 2048 }))
    expect(screen.getByText('2.0 viewer.unitKB')).toBeTruthy()
    kb.unmount()
    mount(readyFile({ size: 3 * 1024 * 1024 }))
    expect(screen.getByText('3.0 viewer.unitMB')).toBeTruthy()
  })

  it('the close button invokes the injected close callback', () => {
    const { close } = mount(readyFile())
    fireEvent.click(screen.getByRole('button', { name: 'viewer.close' }))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('re-renders to nothing when the file is cleared', () => {
    const { instance, container } = mount(readyFile())
    expect(container.firstElementChild).not.toBeNull()
    act(() => { instance.actions.clear() })
    expect(container.firstElementChild).toBeNull()
  })
})

describe('FileViewer — Markdown reader mode', () => {
  it('a ready Markdown file opens in the source view with the toggle present', () => {
    const { container } = mount(readyFile({
      path: '/repo/README.md', content: '# Title\n\nBody **bold**\n', lang: 'md',
    }))
    expect(screen.getByText('viewer.source')).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: 'viewer.toggleMarkdown' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    // Source view: line-numbered gutters, no rendered headings yet.
    expect(gutters(container)).toEqual(['1', '2', '3'])
    expect(container.querySelector('h1')).toBeNull()
  })

  it('the toggle renders the GFM document and flips back to the source view', () => {
    const { instance, container } = mount(readyFile({
      path: '/repo/README.md', content: '# Title\n\nBody **bold**\n', lang: 'md',
    }))
    act(() => { instance.actions.setRenderMode('rendered') })
    expect(screen.getByText('viewer.rendered')).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    const heading = container.querySelector('h1')
    expect(heading?.textContent).toContain('Title')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(gutters(container)).toEqual([])

    act(() => { instance.actions.setRenderMode('source') })
    expect(screen.getByText('viewer.source')).toBeTruthy()
    expect(gutters(container)).toEqual(['1', '2', '3'])
  })

  it('the root carries data-render-mode only while the reader is offered', () => {
    const plain = mount(readyFile())
    expect(plain.container.firstElementChild!.hasAttribute('data-render-mode')).toBe(false)
    plain.unmount()

    const md = mount(readyFile({ path: '/r.md', content: '# T\n', lang: 'md' }))
    expect(md.container.firstElementChild!.getAttribute('data-render-mode')).toBe('source')
    act(() => { md.instance.actions.setRenderMode('rendered') })
    expect(md.container.firstElementChild!.getAttribute('data-render-mode')).toBe('rendered')
  })

  it('non-Markdown files offer no toggle', () => {
    mount(readyFile({ path: '/repo/code.ts', lang: 'ts' }))
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('binary refusals hide the toggle even for a Markdown path', () => {
    mount(readyFile({ path: '/repo/a.md', lang: 'md', binary: true, content: '' }))
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('.mdx documents offer the reader through the shared predicate', () => {
    mount(readyFile({ path: '/repo/slide.mdx', lang: 'mdx', content: '# X\n' }))
    expect(screen.getByRole('switch', { name: 'viewer.toggleMarkdown' })).toBeTruthy()
  })
})
