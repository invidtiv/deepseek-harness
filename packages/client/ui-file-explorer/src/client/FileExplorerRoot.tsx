/**
 * FileExplorerRoot: the explorer column's content. Expanded, it renders a
 * header (title + collapse) and a lazy file tree rooted at the Host's default
 * project root: directory rows expand on click (one Host listing per level,
 * cached per path), file rows route to the injected opener (the file-viewer
 * drawer when composed in, the Host's default application otherwise).
 * Collapsed, it renders one pinned folder tab that requests the expand.
 * Directory rows sort before files within a level (locale order); hidden rows
 * render like any other; a truncated level appends a truncation note. Plain
 * local state holds the tree caches: the column never unmounts (the frame
 * folds it to rail width), so nothing survives a fold that must not. One
 * fetch flies per path at most: a pending or ready cache short-circuits,
 * and only an error status retries in place.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileListing, FileListingEntry } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'explorer' entry) into this
// program, so PropsRuntime<'explorer'> resolves its owner props.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { NS } from './locales.ts'
import css from './FileExplorerRoot.module.css'

/** Injected share of the explorer entry: layout toggle, open routing, and Host listings. */
export interface FileExplorerInjected {
  /** Toggle the column through the layout service (both pinned tabs use it). */
  toggle: () => void
  /**
   * Route a file row out of the tree: the file-viewer drawer when composed
   * in, the Host's default application otherwise (ui-conversation's fallback).
   */
  openFile: (path: string) => void
  /**
   * List one mixed directory level through the workspaces face; an absent
   * path lists the default project root.
   */
  listFiles: (path?: string, signal?: AbortSignal) => Promise<FileListing>
}

/** Full explorer props: runtime owner share + injected callbacks + locale seat. */
export type FileExplorerProps =
  & PropsRuntime<'explorer'>
  & InjectFace<FileExplorerInjected>
  & PropsLocale<typeof NS>

/** One fetched level's lifecycle under its authoritative absolute-path key. */
type Level =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: readonly FileListingEntry[]; truncated: boolean }

/** Row indent per depth step inside the tree body. */
const INDENT_PX = 12

/** Inline document glyph for file rows (no primitives icon carries a plain page mark). */
function DocumentGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={css.docGlyph}>
      <rect x="3.5" y="1.5" width="9" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 5h4M6 8h4M6 11h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Directory rows first, then names ascending — both locale-ordered so the
 * client sort agrees with the Host's name ordering inside each partition.
 * @param entries - the level's rows as returned.
 * @returns the display order (a fresh array; the wire array is never mutated).
 */
function displayOrder(entries: readonly FileListingEntry[]): readonly FileListingEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function FileExplorerRoot({
  collapsed, toggle, openFile, listFiles, t,
}: FileExplorerProps) {
  // Levels are keyed by the exact strings the tree navigates with: '' is the
  // sentinel root request (absent payload), everything else is a child
  // entry's absolute path as returned by the previous level. A response's
  // echoed path — not the request string — keys the record, so the root
  // lands under its resolved absolute path while this render reads that
  // same authoritative key back for the first subtree.
  const [rootPath, setRootPath] = useState('')
  const [levels, setLevels] = useState<ReadonlyMap<string, Level>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  // Highlighted file row; purely visual follow-through for clicks.
  const [selected, setSelected] = useState<string | undefined>(undefined)

  // Event-handler mirrors of state above: stable callbacks read caches
  // without depending on every state change that flows through renders.
  const levelsRef = useRef(levels)
  levelsRef.current = levels
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  /**
   * Fetch one level into the cache unless a non-error record already exists;
   * failures store the error status under the requested key so the same key
   * retries in place.
   */
  const load = useCallback((dirPath: string) => {
    const cached = levelsRef.current.get(dirPath)
    if (cached !== undefined && cached.status !== 'error') return
    setLevels(prev => new Map(prev).set(dirPath, { status: 'loading' }))
    void listFiles(dirPath === '' ? undefined : dirPath).then(
      (listing) => {
        if (dirPath === '') setRootPath(listing.path)
        setLevels(prev => new Map(prev).set(listing.path, {
          status: 'ready', entries: listing.entries, truncated: listing.truncated,
        }))
      },
      () => {
        setLevels(prev => new Map(prev).set(dirPath, { status: 'error' }))
      },
    )
  }, [listFiles])

  // First paint lists the project root once; plugin reloads start a new
  // fiber with fresh component state, so no stale-request interleave remains.
  useEffect(() => { load('') }, [load])

  /** Expand one directory (fetching when uncached) or collapse it (cache kept for re-expand). */
  const toggleDir = useCallback((entry: FileListingEntry) => {
    if (expandedRef.current.has(entry.path)) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(entry.path)
        return next
      })
      return
    }
    setExpanded(prev => new Set(prev).add(entry.path))
    load(entry.path)
  }, [load])

  const chooseFile = useCallback((entry: FileListingEntry) => {
    setSelected(entry.path)
    openFile(entry.path)
  }, [openFile])

  const retryRoot = useCallback(() => { load('') }, [load])

  /**
   * One subtree render pass: rows plus any expanded children below them.
   * @param entries - the rows of the level being drawn.
   * @param depth - indent step of this level (root = 0).
   * @returns the rows of this subtree, expanded descendants included.
   */
  function renderRows(entries: readonly FileListingEntry[], depth: number) {
    const rows: ReactNode[] = []
    for (const entry of displayOrder(entries)) {
      const isOpen = expanded.has(entry.path)
      const indent = { paddingInlineStart: `${depth * INDENT_PX + 10}px` }
      if (entry.kind === 'directory') {
        rows.push(
          <button
            key={entry.path}
            type="button"
            className={clsx(css.row, css.dirRow)}
            style={indent}
            aria-expanded={isOpen}
            title={entry.path}
            onClick={() => { toggleDir(entry) }}
          >
            <IconChevronRightOutline14 className={clsx(css.chevron, isOpen && css.chevronOpen)} />
            {isOpen ? <IconFolderOpen16 /> : <IconFolderClose16 />}
            <span className={css.rowName}>{entry.name}</span>
          </button>,
        )
        if (!isOpen) continue
        const child = levels.get(entry.path)
        if (child?.status === 'ready') {
          rows.push(...renderRows(child.entries, depth + 1))
          if (child.truncated) {
            rows.push(
              <div
                key={`${entry.path}#truncated`}
                className={css.note}
                style={{ paddingInlineStart: `${(depth + 1) * INDENT_PX + 10}px` }}
              >
                {t('explorer.truncated')}
              </div>,
            )
          }
        } else if (child?.status === 'error') {
          rows.push(
            <div
              key={`${entry.path}#error`}
              className={css.note}
              style={{ paddingInlineStart: `${(depth + 1) * INDENT_PX + 10}px` }}
            >
              {t('explorer.unreadable')}
              <button
                type="button"
                className={css.retry}
                aria-label={t('explorer.retry')}
                onClick={() => { load(entry.path) }}
              >
                {t('explorer.retry')}
              </button>
            </div>,
          )
        } else {
          rows.push(
            <div
              key={`${entry.path}#loading`}
              className={css.note}
              style={{ paddingInlineStart: `${(depth + 1) * INDENT_PX + 10}px` }}
            >
              {t('explorer.loading')}
            </div>,
          )
        }
      } else {
        rows.push(
          <button
            key={entry.path}
            type="button"
            className={clsx(css.row, selected === entry.path && css.selected)}
            style={indent}
            aria-current={selected === entry.path || undefined}
            title={entry.path}
            onClick={() => { chooseFile(entry) }}
          >
            <DocumentGlyph />
            <span className={css.rowName}>{entry.name}</span>
          </button>,
        )
      }
    }
    return rows
  }

  const rootLevel = levels.get(rootPath)

  let body: ReactNode
  if (rootLevel === undefined || rootLevel.status === 'loading') {
    body = <div className={css.status}>{t('explorer.loading')}</div>
  } else if (rootLevel.status === 'error') {
    body = (
      <div className={css.status}>
        {t('explorer.error')}
        <button type="button" className={css.retryWide} aria-label={t('explorer.retry')} onClick={retryRoot}>
          {t('explorer.retry')}
        </button>
      </div>
    )
  } else {
    body = (
      <>
        {renderRows(rootLevel.entries, 0)}
        {rootLevel.truncated && <div className={css.note} style={{ paddingInlineStart: '10px' }}>{t('explorer.truncated')}</div>}
      </>
    )
  }

  if (collapsed) {
    return (
      <div className={css.rail}>
        <button
          type="button"
          className={css.railTab}
          aria-label={t('explorer.show')}
          title={t('explorer.show')}
          onClick={toggle}
        >
          <IconFolderClose16 />
        </button>
      </div>
    )
  }

  return (
    <div className={css.root} data-level-status={rootLevel?.status ?? 'loading'}>
      <div className={css.header}>
        <span className={css.title}>{t('explorer.title')}</span>
        <button
          type="button"
          className={css.headerButton}
          aria-label={t('explorer.hide')}
          title={t('explorer.hide')}
          onClick={toggle}
        >
          {/* Collapse affordance points off-frame (rightward): the column
              slides toward its right-edge rail. */}
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l4 4-4 4M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
      </div>
      <div className={css.body}>{body}</div>
    </div>
  )
}
