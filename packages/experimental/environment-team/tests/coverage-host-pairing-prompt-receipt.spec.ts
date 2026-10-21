/** Durable prompt retry fingerprints under duplicate delivery and concurrent first writes. */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { environmentIdSchema } from '../src/protocol.ts'
import { pinAttachmentPrompt } from '../src/prompt-receipt.ts'
import { sessionRequestSchema } from '../src/session-protocol.ts'

const link = vi.hoisted(() => ({
  before: undefined as ((target: string) => Promise<void>) | undefined,
  failure: undefined as Error | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async link(existing: string, target: string) {
      await link.before?.(target)
      if (link.failure) throw link.failure
      return actual.link(existing, target)
    },
  }
})

const environment = environmentIdSchema.parse(randomUUID())
let directory = ''
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-prompt-receipt-')) })
afterEach(async () => {
  link.before = undefined
  link.failure = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

function prompt(text: string, images?: { data: string; mediaType: 'image/png'; name?: string }[]) {
  const request = sessionRequestSchema.parse({ action: 'prompt', workspaceId: 'workspace', sessionId: 'session', requestId: 'request', text, ...(images ? { images } : {}) })
  if (request.action !== 'prompt') throw new Error('expected prompt')
  return request
}
const receipts = async () => (await readdir(join(directory, 'prompt-receipts'))).filter(name => !name.startsWith('.pending-'))
const pending = async () => (await readdir(join(directory, 'prompt-receipts'))).filter(name => name.startsWith('.pending-'))

it('accepts an identical retry and rejects different content for the same identifier', async () => {
  const request = prompt('look', [{ data: 'AAAA', mediaType: 'image/png', name: 'first.png' }, { data: 'BBBB', mediaType: 'image/png' }])
  await pinAttachmentPrompt(directory, environment, request, false)
  await pinAttachmentPrompt(directory, environment, request, true)
  await expect(pinAttachmentPrompt(directory, environment, prompt('look', [{ data: 'AAAA', mediaType: 'image/png' }]), false)).rejects.toThrow('different content')
  expect(await receipts()).toHaveLength(1)
  expect(await pending()).toEqual([])
})

it('refuses to invent a receipt for an identifier already owned by an older message', async () => {
  await expect(pinAttachmentPrompt(directory, environment, prompt('look'), true)).rejects.toThrow('different content')
  await expect(readdir(join(directory, 'prompt-receipts'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('accepts a concurrent writer of the same content and rejects one with different content', async () => {
  const request = prompt('same')
  link.before = async () => { link.before = undefined; await pinAttachmentPrompt(directory, environment, request, false) }
  await pinAttachmentPrompt(directory, environment, request, false)
  expect(await receipts()).toHaveLength(1)
  expect(await pending()).toEqual([])
  await rm(join(directory, 'prompt-receipts'), { recursive: true })
  link.before = async () => { link.before = undefined; await pinAttachmentPrompt(directory, environment, prompt('winner'), false) }
  await expect(pinAttachmentPrompt(directory, environment, request, false)).rejects.toThrow('different content')
  expect(await pending()).toEqual([])
})

it('reports a link failure other than an existing receipt and removes its pending file', async () => {
  link.failure = Object.assign(new Error('link denied'), { code: 'EACCES' })
  await expect(pinAttachmentPrompt(directory, environment, prompt('denied'), false)).rejects.toThrow('link denied')
  expect(await receipts()).toEqual([])
  expect(await pending()).toEqual([])
})
