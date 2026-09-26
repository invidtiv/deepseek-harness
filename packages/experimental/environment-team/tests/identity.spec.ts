/** Filesystem publication failures must preserve retryable identity initialization. */
import { mkdtemp, readdir, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadIdentity } from '../src/identity.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, link: vi.fn(fs.link) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(link).mockClear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('cleans incomplete publication and propagates filesystem failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-identity-failure-'))
  roots.push(root)
  vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('hard links unavailable'), { code: 'EPERM' }))
  await expect(loadIdentity(root)).rejects.toThrow('hard links unavailable')
  expect(await readdir(root)).toEqual([])
  const id = await loadIdentity(root)
  expect(await loadIdentity(root)).toBe(id)
})
