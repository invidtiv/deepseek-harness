/**
 * FileViewer: the right-side drawer's content — a header (basename + full
 * path + close), a metadata row (language, line count, size, truncation), and
 * a scrollable body. Plain text draws the line-numbered, syntax-highlighted
 * source (ui-primitives' shiki per-line highlighter, the read card's path, so
 * token colors stay on the `--shiki-*` theme tokens; an unknown or
 * not-yet-loaded language renders plain monospace). A `.md`/`.mdx` document
 * additionally offers the Markdown reader — a `rendered`/`source` toggle in
 * the header switches between ui-primitives' settled GFM+KaTeX pipeline and
 * the plain source view. The drawer stays mounted at zero width when closed;
 * `activeFile === null` returns nothing.
 */

import { memo, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  grammarLoadCount, highlightLines, subscribeGrammarLoaded, type HighlightSpan,
  MarkdownText, type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { createFileViewerStore } from './stores.ts'
import { basename, isMarkdownLang } from './langFromPath.ts'
import type { NS } from './locales.ts'
import css from './FileViewer.module.css'

/** Injected share of the file-viewer entry: the close gesture. */
export interface FileViewerInjected {
  /** Close the drawer and clear the active file. */
  close: () => void
}

/** Full file-viewer props: store share, injected share, and the locale seat. */
export type FileViewerProps = PropsStore<ReturnType<typeof createFileViewerStore>>
  & InjectFace<FileViewerInjected> & PropsLocale<typeof NS>

/** Split decoded text into display lines; a trailing newline is not an extra empty line. */
function splitLines(content: string): readonly string[] {
  if (content === '') return []
  const source = content.endsWith('\n') ? content.slice(0, -1) : content
  return source.split('\n')
}

/** Render one line's highlighted runs (the css-variables theme colors every run). */
function renderSpans(spans: readonly HighlightSpan[]) {
  return spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
}

/** Compact byte count for the metadata row; unit copy comes from the locale dictionary. */
function formatSize(bytes: number, t: FileViewerProps['t']): string {
  if (bytes < 1024) return `${bytes} ${t('viewer.unitB')}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('viewer.unitKB')}`
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('viewer.unitMB')}`
}

/** Line-numbered, highlighted source body. */
function CodeLines({ content, lang }: { content: string; lang: string | undefined }) {
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const lines = useMemo(() => splitLines(content), [content])
  const highlighted = useMemo(() => highlightLines(content, lang), [content, lang, loaded])
  return (
    <div className={css.code}>
      {lines.map((line, index) => {
        const spans = highlighted?.[index]
        return (
          <div key={index} className={css.line}>
            <span className={css.gutter} aria-hidden>{index + 1}</span>
            <span className={css.content}>{spans === undefined ? line : renderSpans(spans)}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Render the file viewer drawer.
 * @param props - store share, injected close, and the locale seat.
 * @returns the drawer, or nothing when no file is active.
 */
/** Stable-per-locale-revision Markdown chrome copy for the rendered reader. */
function markdownLabels(t: FileViewerProps['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('viewer.copy'), copiedLabel: t('viewer.copied') },
    footnotes: t('viewer.footnotes'),
  }
}

export const FileViewer = memo(function FileViewer({ useStore, actions, close, t }: FileViewerProps) {
  const activeFile = useStore(s => s.activeFile)
  const renderMode = useStore(s => s.renderMode)
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every render.
  const labels = useMemo(() => markdownLabels(t), [t])
  if (activeFile === null) return null
  const markdown = activeFile.status === 'ready' && !activeFile.binary
    && isMarkdownLang(activeFile.lang)
  const lineCount = activeFile.status === 'ready' ? splitLines(activeFile.content).length : 0

  let body: ReactNode
  switch (activeFile.status) {
    case 'loading':
      body = <div className={css.status}>{t('viewer.loading')}</div>
      break
    case 'error':
      body = <div className={css.status}>{t('viewer.error')}</div>
      break
    case 'ready':
      if (activeFile.binary) body = <div className={css.status}>{t('viewer.binary')}</div>
      else if (lineCount === 0) body = <div className={css.status}>{t('viewer.empty')}</div>
      else if (markdown && renderMode === 'rendered') {
        body = (
          <div className={css.markdownBody}>
            <MarkdownText text={activeFile.content} labels={labels} />
          </div>
        )
      } else body = <CodeLines content={activeFile.content} lang={activeFile.lang} />
      break
  }

  return (
    <div className={css.root} data-status={activeFile.status} data-render-mode={markdown ? renderMode : undefined}>
      <div className={css.header}>
        <div className={css.title}>
          <div className={css.basename}>{basename(activeFile.path)}</div>
          <div className={css.path} title={activeFile.path}>{activeFile.path}</div>
        </div>
        {markdown && (
          <>
            <span className={css.modeLabel}>
              {renderMode === 'rendered' ? t('viewer.rendered') : t('viewer.source')}
            </span>
            <button
              type="button"
              className={css.toggle}
              role="switch"
              aria-checked={renderMode === 'rendered'}
              aria-label={t('viewer.toggleMarkdown')}
              title={t('viewer.toggleMarkdown')}
              onClick={() => {
                actions.setRenderMode(renderMode === 'rendered' ? 'source' : 'rendered')
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path d="M2 8h12M9.5 3.5 14 8l-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          </>
        )}
        <button type="button" className={css.close} aria-label={t('viewer.close')} onClick={close}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {activeFile.status === 'ready' && (
        <div className={css.meta}>
          <span className={css.metaItem}>{activeFile.lang ?? t('viewer.plainText')}</span>
          <span className={css.metaItem}>{lineCount} {t('viewer.lines')}</span>
          <span className={css.metaItem}>{formatSize(activeFile.size, t)}</span>
          {activeFile.truncated && <span className={css.truncated}>{t('viewer.truncated')}</span>}
        </div>
      )}
      <div className={css.body}>{body}</div>
    </div>
  )
})
