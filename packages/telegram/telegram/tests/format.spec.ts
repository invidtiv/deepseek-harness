import { describe, expect, it } from 'vitest'
import { chunkHtml, formatTelegramHtml } from '../src/render.ts'
import { MAX_MESSAGE_CHARS } from '../src/config.ts'

describe('formatTelegramHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(formatTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('wraps fenced code blocks in pre tags and leaves fences with no terminator literal', () => {
    expect(formatTelegramHtml('before\n```js\nconst x = 1 < 2;\n```\nafter'))
      .toBe('before\n<pre>const x = 1 &lt; 2;</pre>\nafter')
    expect(formatTelegramHtml('```js\nunclosed')).toBe('```js\nunclosed')
  })
})

describe('chunkHtml', () => {
  it('returns the input untouched within the limit', () => {
    expect(chunkHtml('short text')).toEqual(['short text'])
  })

  it('keeps every chunk within the hard limit', () => {
    const text = 'x'.repeat(MAX_MESSAGE_CHARS * 3 + 10)
    const chunks = chunkHtml(text)
    expect(chunks).toHaveLength(4)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(chunks.join('')).toBe(text)
  })

  it('splits on newline boundaries before hard-splitting', () => {
    const line = 'y'.repeat(3000)
    const chunks = chunkHtml(`${line}\n${line}`)
    expect(chunks).toEqual([line, line])
  })

  it('keeps a long pre block as self-contained wrapped messages', () => {
    const code = 'z'.repeat(MAX_MESSAGE_CHARS + 100)
    const chunks = chunkHtml(`<pre>${code}</pre>`)
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) {
      expect(chunk.startsWith('<pre>')).toBe(true)
      expect(chunk.endsWith('</pre>')).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    }
  })

  it('never leaves a chunk with an unclosed pre tag when a pre follows text', () => {
    const text = 'a'.repeat(MAX_MESSAGE_CHARS - 10)
    const chunks = chunkHtml(`${text}<pre>code</pre>`)
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre>/gu) ?? []).length
      const closes = (chunk.match(/<\/pre>/gu) ?? []).length
      expect(opens).toBe(closes)
    }
  })
})
