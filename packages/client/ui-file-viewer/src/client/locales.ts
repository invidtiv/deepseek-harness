/** `fileViewer` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'fileViewer'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'viewer.close': '关闭文件查看器',
  'viewer.loading': '正在读取文件…',
  'viewer.error': '无法读取文件',
  'viewer.binary': '无法显示二进制文件',
  'viewer.empty': '文件为空',
  'viewer.truncated': '内容已截断',
  'viewer.lines': '行',
  'viewer.bytes': '字节',
  // Metadata-row units and the no-highlight fallback (locale-owned copy).
  'viewer.unitB': 'B',
  'viewer.unitKB': 'KB',
  'viewer.unitMB': 'MB',
  'viewer.plainText': '纯文本',
  // Markdown reader mode: rendered/reveal copy and the toggle's accessible name.
  'viewer.rendered': '渲染视图',
  'viewer.source': '源码视图',
  'viewer.toggleMarkdown': '切换 Markdown 渲染/源码视图',
  // Copy-button labels forwarded to fence CodeBlocks while rendered.
  'viewer.copy': '复制',
  'viewer.copied': '已复制',
  // Footnotes section heading in rendered mode.
  'viewer.footnotes': '脚注',
}

/** English dictionary (same key set). */
export const en: Record<FileViewerKey, string> = {
  'viewer.close': 'Close file viewer',
  'viewer.loading': 'Reading file…',
  'viewer.error': 'Failed to read file',
  'viewer.binary': 'Cannot display a binary file',
  'viewer.empty': 'File is empty',
  'viewer.truncated': 'content truncated',
  'viewer.lines': 'lines',
  'viewer.bytes': 'bytes',
  // Metadata-row units and the no-highlight fallback.
  'viewer.unitB': 'B',
  'viewer.unitKB': 'KB',
  'viewer.unitMB': 'MB',
  'viewer.plainText': 'text',
  // Markdown reader mode.
  'viewer.rendered': 'Rendered view',
  'viewer.source': 'Source view',
  'viewer.toggleMarkdown': 'Toggle Markdown rendering / source',
  // Fence copy buttons in rendered mode.
  'viewer.copy': 'Copy',
  'viewer.copied': 'Copied',
  // Footnotes section heading in rendered mode.
  'viewer.footnotes': 'Footnotes',
}

/** Union of this namespace's dictionary keys. */
export type FileViewerKey = keyof typeof zh
