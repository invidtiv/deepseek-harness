/** `fileExplorer` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'fileExplorer'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'explorer.title': '文件',
  'explorer.show': '展开文件浏览器',
  'explorer.hide': '折叠文件浏览器',
  'explorer.loading': '正在读取目录…',
  'explorer.error': '无法读取项目根目录',
  'explorer.unreadable': '目录不可读',
  'explorer.retry': '重试',
  'explorer.truncated': '目录过大，列表已截断',
}

/** English dictionary (same key set). */
export const en: Record<FileExplorerKey, string> = {
  'explorer.title': 'Files',
  'explorer.show': 'Expand file explorer',
  'explorer.hide': 'Collapse file explorer',
  'explorer.loading': 'Reading directory…',
  'explorer.error': 'Failed to read the project root',
  'explorer.unreadable': 'Directory is unreadable',
  'explorer.retry': 'Retry',
  'explorer.truncated': 'Directory too large — listing truncated',
}

/** Union of this namespace's dictionary keys. */
export type FileExplorerKey = keyof typeof zh
