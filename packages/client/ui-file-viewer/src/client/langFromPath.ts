/**
 * Lowercased file-extension to syntax-highlighting language hint. Keys are the
 * extension without its dot; the hint ids are exactly the aliases
 * `highlightLines` (ui-primitives) resolves, so a file viewer never emits a
 * hint the highlighter cannot map. A UI treats an absent key as plain text.
 */
/* jscpd:ignore-start -- the client drawer deliberately mirrors the Host tool-fs
   read-render table: the module graph forbids a browser bundle importing a host
   tool package, and the alias surface stays pinned on each side by unit tests */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'md', markdown: 'md', mdx: 'mdx',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

/**
 * Derive a syntax-highlighting language hint from a file path's extension.
 * Pure and case-insensitive on the extension; a dotfile with no extension
 * (`.gitignore`) and an unknown extension both yield `undefined`.
 * @param path - the absolute or relative path to hint.
 * @returns the language hint for {@link LANG_BY_EXTENSION}, or `undefined` when the extension maps to none.
 */
export function langFromPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  // A leading dot is a dotfile (no extension), not an empty extension.
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}
/* jscpd:ignore-end */

/**
 * Trailing path segment, the part that identifies the file at a glance.
 * @param path - slash- or backslash-separated path.
 * @returns the final segment, or the whole string when separator-free.
 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * Whether a language hint names a Markdown document the drawer can render
 * through ui-primitives' GFM pipeline. The single fact behind both gates:
 * the controller's reader-mode persistence and the drawer's toggle visibility.
 * @param lang - a {@link langFromPath} hint.
 * @returns whether the hint names a Markdown document family.
 */
export function isMarkdownLang(lang: string | undefined): boolean {
  return lang === 'md' || lang === 'mdx'
}
