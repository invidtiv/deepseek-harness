import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceGuard, WorkspaceSelectionError } from '../src/workspaces.ts'

describe('WorkspaceGuard', () => {
  let root: string
  let outside: string

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  async function setup(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'telegram-guard-root-'))
    outside = await mkdtemp(join(tmpdir(), 'telegram-guard-out-'))
  }

  it('rejects relative paths without touching the filesystem', async () => {
    await setup()
    const guard = await WorkspaceGuard.fromConfig([root])
    await expect(guard.select('relative/path')).rejects.toBeInstanceOf(WorkspaceSelectionError)
    await expect(guard.select(join(root, '..', '..'))).rejects.toBeInstanceOf(WorkspaceSelectionError)
  })

  it('rejects missing paths and files', async () => {
    await setup()
    const guard = await WorkspaceGuard.fromConfig([root])
    await expect(guard.select(join(root, 'missing'))).rejects.toBeInstanceOf(WorkspaceSelectionError)
    const file = join(root, 'file.txt')
    await writeFile(file, 'data')
    await expect(guard.select(file)).rejects.toThrow(/not a directory/)
  })

  it('fails load when a configured root does not resolve', async () => {
    await expect(WorkspaceGuard.fromConfig([join(tmpdir(), 'missing-root-xyz')]))
      .rejects.toBeInstanceOf(WorkspaceSelectionError)
  })

  it('canonicalizes symlinks and refuses targets outside every root', async () => {
    await setup()
    const inside = join(root, 'project')
    await mkdir(inside)
    const link = join(outside, 'project-link')
    await symlink(inside, link, 'dir')
    const guard = await WorkspaceGuard.fromConfig([root])
    await expect(guard.select(link)).resolves.toBe(await guard.select(inside))
    await expect(guard.select(outside)).rejects.toThrow(/outside the configured workspace roots/)
  })

  it('refuses traversal spellings that resolve outside the root', async () => {
    await setup()
    await mkdir(join(root, 'sub'))
    const guard = await WorkspaceGuard.fromConfig([join(root, 'sub')])
    await expect(guard.select(join(root, 'sub', '..'))).rejects.toThrow(/outside the configured workspace roots/)
  })
})
