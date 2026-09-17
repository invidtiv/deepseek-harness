// @vitest-environment jsdom
/**
 * FileExplorerRoot behavior: root load on first paint (loading -> rows,
 * directories before files), per-directory lazy fetch with cached re-expand,
 * error + retry at the root and inside a child level, truncation notes on
 * both levels, file click routing with selection highlight, both pinned tabs
 * (rail expand, header collapse), and the project root following the selected
 * Session. `t` is a key-echoing stub so copy assertions pin keys, not locales;
 * the injected face arrives as plain vi.fn callbacks exactly as the register
 * inject factory produces them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileExplorerRoot } from '../src/client/FileExplorerRoot.tsx'
import type { FileExplorerProps } from '../src/client/FileExplorerRoot.tsx'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FileListing, FileListingEntry } from '@deepseek-ai/dsh-api-workspace-controller/client'

afterEach(cleanup)

const t = ((key: string) => key) as FileExplorerProps['t']

/** The selected Session whose cwd the tree roots at. */
const SESSION = 's-project'

/**
 * The global session kit, reduced to the one fact the tree reads: which
 * Session the main view retains and the cwd it records. `undefined` stands for
 * the no-session page state.
 * @param cwd - the selected Session's working directory, or undefined with no selected Session.
 * @returns the `useSessions` seat over that snapshot.
 */
function sessionsHook(cwd: string | undefined): FileExplorerProps['useSessions'] {
  const state = {
    ids: cwd === undefined ? [] : [SESSION],
    byId: cwd === undefined ? {} : {
      [SESSION]: {
        id: SESSION,
        displayTitle: 'project',
        running: false,
        retainedBy: { mainView: 1 },
        blank: false,
        updatedAt: 0,
        ...(cwd === undefined ? {} : { cwd }),
      },
    },
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState
  return ((select: (s: SessionListState) => unknown) => select(state)) as FileExplorerProps['useSessions']
}

const dir = (name: string, path: string, hidden = false): FileListingEntry => ({ name, path, kind: 'directory', hidden })
const file = (name: string, path: string, hidden = false): FileListingEntry => ({ name, path, kind: 'file', hidden })

const ROOT: FileListing = {
  path: '/repo',
  entries: [dir('src', '/repo/src'), file('README.md', '/repo/README.md'), file('package.json', '/repo/package.json'), dir('.github', '/repo/.github', true)],
  truncated: false,
}
const SRC: FileListing = {
  path: '/repo/src',
  entries: [file('a.ts', '/repo/src/a.ts'), dir('util', '/repo/src/util')],
  truncated: false,
}

/** Row names in display order off the DOM (row buttons only). */
function rowNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class^="_row_"]')].map(el => el.textContent ?? '')
}

interface Harness {
  listFiles: ReturnType<typeof vi.fn>
  openFile: ReturnType<typeof vi.fn>
  toggle: ReturnType<typeof vi.fn>
  container: HTMLElement
}

function mount(over: Partial<FileExplorerProps> = {}, listing: (path?: string) => Promise<FileListing> = async path => (path === '/repo/src' ? SRC : { ...ROOT, path: path ?? '/repo' })): Harness {
  const listFiles = vi.fn(listing)
  const openFile = vi.fn()
  const toggle = vi.fn()
  const props: FileExplorerProps = {
    collapsed: false, width: 300, useSessions: sessionsHook('/repo'),
    ...over, listFiles, openFile, toggle, t,
  } as FileExplorerProps
  const utils = render(<FileExplorerRoot {...props} />)
  return { listFiles, openFile, toggle, container: utils.container }
}

/** Wait until the row with the given text exists. */
async function waitForRow(name: string): Promise<void> {
  await waitFor(() => { expect(screen.getByText(name)).toBeTruthy() })
}

describe('FileExplorerRoot — tree body', () => {
  it('lists the selected project root once on mount: loading first, then rows sorted dirs-first by name', async () => {
    let settle: ((value: FileListing) => void) | undefined
    const h = mount({}, () => new Promise<FileListing>((resolve) => { settle = resolve }))
    expect(screen.getByText('explorer.loading')).toBeTruthy()
    expect(h.listFiles).toHaveBeenCalledWith('/repo')
    await waitFor(() => { expect(settle).toBeDefined() })
    // Resolve out of natural order so the client sort (not wire order) wins.
    settle!({ path: '/repo', entries: [...ROOT.entries], truncated: false })
    await waitForRow('README.md')
    expect(rowNames(h.container)).toEqual(['.github', 'src', 'package.json', 'README.md'])
    expect(h.listFiles).toHaveBeenCalledTimes(1)
  })

  it('asks the Host for its default project root while no Session is selected', async () => {
    const h = mount({ useSessions: sessionsHook(undefined) })
    await waitForRow('src')
    expect(h.listFiles).toHaveBeenCalledWith(undefined)
    expect(h.container.querySelector('[data-level-status="ready"]')).toBeTruthy()
  })

  it('re-roots on a selection in another project and drops the previous tree', async () => {
    const listFiles = vi.fn(async (path?: string): Promise<FileListing> => (
      path === '/work/app'
        ? { path: '/work/app', entries: [file('app.ts', '/work/app/app.ts')], truncated: false }
        : { path: '/other/repo', entries: [file('other.ts', '/other/repo/other.ts')], truncated: false }
    ))
    const shared = { collapsed: false, width: 300, listFiles, openFile: vi.fn(), toggle: vi.fn(), t } as FileExplorerProps
    const view = render(<FileExplorerRoot {...shared} useSessions={sessionsHook('/work/app')} />)
    await waitForRow('app.ts')
    view.rerender(<FileExplorerRoot {...shared} useSessions={sessionsHook('/other/repo')} />)
    await waitForRow('other.ts')
    expect(screen.queryByText('app.ts')).toBeNull()
    expect(listFiles).toHaveBeenNthCalledWith(1, '/work/app')
    expect(listFiles).toHaveBeenNthCalledWith(2, '/other/repo')
  })

  it('expands a directory through one fetch and serves re-expansion from the cache', async () => {
    const h = mount()
    await waitForRow('src')
    fireEvent.click(screen.getByText('src'))
    await waitForRow('a.ts')
    expect(rowNames(h.container)).toEqual(['.github', 'src', 'util', 'a.ts', 'package.json', 'README.md'])
    expect(h.listFiles).toHaveBeenLastCalledWith('/repo/src')
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => { expect(screen.queryByText('a.ts')).toBeNull() })
    fireEvent.click(screen.getByText('src'))
    await waitForRow('a.ts')
    expect(h.listFiles).toHaveBeenCalledTimes(2)
  })

  it('routes a file click to the opener and highlights the row', async () => {
    const h = mount()
    await waitForRow('package.json')
    fireEvent.click(screen.getByText('package.json'))
    expect(h.openFile).toHaveBeenCalledWith('/repo/package.json')
    expect(h.container.querySelector('[aria-current="true"]')?.textContent).toBe('package.json')
  })

  it('renders a truncated root note after the rows', async () => {
    mount({}, async path => ({ path: path ?? '/repo', entries: [...ROOT.entries], truncated: true }))
    await waitForRow('README.md')
    expect(screen.getByText('explorer.truncated')).toBeTruthy()
  })

  it('expanding a directory shows its loading note, then its children and its own truncation note', async () => {
    let second: ((value: FileListing) => void) | undefined
    mount({}, async (path) => {
      if (path !== undefined && path === '/repo/src') {
        return new Promise<FileListing>((resolve) => { second = resolve })
      }
      return ROOT
    })
    await waitForRow('src')
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => { expect(screen.getByText('explorer.loading')).toBeTruthy() })
    second!({ path: '/repo/src', entries: [...SRC.entries], truncated: true })
    await waitFor(() => { expect(screen.getByText('explorer.truncated')).toBeTruthy() })
    expect(screen.getByText('a.ts')).toBeTruthy()
  })

  it('an unreadable child level retries in place and recovers its rows', async () => {
    let calls = 0
    mount({}, async (path) => {
      if (path === '/repo/src') {
        calls += 1
        if (calls === 1) throw new Error('denied')
        return SRC
      }
      return ROOT
    })
    await waitForRow('src')
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => { expect(screen.getByText('explorer.unreadable')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'explorer.retry' }))
    await waitForRow('a.ts')
    expect(calls).toBe(2)
  })

  it('a root-level failure offers the wide retry which refetches the root', async () => {
    let calls = 0
    mount({}, async () => {
      calls += 1
      if (calls === 1) throw new Error('offline')
      return ROOT
    })
    await waitFor(() => { expect(screen.getByText('explorer.error')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'explorer.retry' }))
    await waitForRow('README.md')
    expect(calls).toBe(2)
  })
})

describe('FileExplorerRoot — column chrome', () => {
  it('the header collapse tab routes through the injected toggle', () => {
    const { toggle } = mount({ collapsed: false, width: 300 })
    fireEvent.click(screen.getByRole('button', { name: 'explorer.hide' }))
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('collapsed renders only the rail tab, whose click requests expansion', () => {
    const h = mount({ collapsed: true, width: 44 })
    expect(h.container.querySelector('[class^="_root_"]')).toBeNull()
    expect(screen.queryByText('explorer.loading')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'explorer.show' }))
    expect(h.toggle).toHaveBeenCalledTimes(1)
    // The single mount-time warm-up stays: expanding later serves the cached
    // root immediately instead of flashing the loading status.
    expect(h.listFiles).toHaveBeenCalledTimes(1)
  })

  it('remounting starts fresh: no cached levels carry across plugin reloads', async () => {
    const first = mount()
    await waitForRow('src')
    cleanup()
    const secondMount = mount()
    await waitForRow('src')
    // Fresh fiber state re-fetches the root (no module-level handles exist).
    expect(first.listFiles).toHaveBeenCalledTimes(1)
    expect(secondMount.listFiles).toHaveBeenCalledTimes(1)
  })
})
