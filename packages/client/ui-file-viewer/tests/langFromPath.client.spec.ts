import { describe, expect, it } from 'vitest'
import { basename, isMarkdownLang, langFromPath } from '@deepseek-ai/dsh-client-ui-file-viewer/src/client/langFromPath.ts'

describe('langFromPath', () => {
  it('maps common extensions to a highlighter hint, case-insensitively', () => {
    expect(langFromPath('src/a.ts')).toBe('ts')
    expect(langFromPath('src/a.TSX')).toBe('tsx')
    expect(langFromPath('/abs/module.mjs')).toBe('js')
    expect(langFromPath('conf.yml')).toBe('yaml')
    expect(langFromPath('README.md')).toBe('md')
    expect(langFromPath('lib/parser.rs')).toBe('rs')
    expect(langFromPath('main.cpp')).toBe('cpp')
    expect(langFromPath('header.h')).toBe('c')
    expect(langFromPath('style.scss')).toBe('scss')
  })

  it('returns undefined for a dotfile, a directory, and an unknown extension', () => {
    expect(langFromPath('.gitignore')).toBeUndefined()
    expect(langFromPath('/src/component')).toBeUndefined()
    expect(langFromPath('a.py.bak')).toBeUndefined()
    expect(langFromPath('Makefile')).toBeUndefined()
  })
})

describe('basename', () => {
  it('returns the trailing segment for slash and backslash separators', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt')
    expect(basename('C:\\dir\\file.ts')).toBe('file.ts')
  })

  it('returns the whole string when separator-free', () => {
    expect(basename('README.md')).toBe('README.md')
  })
})

describe('isMarkdownLang', () => {
  it('accepts the two Markdown hints and nothing else, including undefined', () => {
    expect(isMarkdownLang('md')).toBe(true)
    expect(isMarkdownLang('mdx')).toBe(true)
    expect(isMarkdownLang(undefined)).toBe(false)
    expect(isMarkdownLang('ts')).toBe(false)
    expect(isMarkdownLang('markdown')).toBe(false)
  })
})
