import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceGuard, WorkspaceSelectionError } from '../src/workspaces.ts'

// The guard's only failure detail comes from the canonicalization error's
// `code`; a rejection without one must still produce a user-facing message.
vi.mock('@deepseek-ai/dsh-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-workspace')>()
  return {
    ...actual,
    realpathNormalize: async (path: string): Promise<string> => {
      if (path.includes('codeless-failure')) throw new Error('realpath refused')
      return await actual.realpathNormalize(path)
    },
  }
})

describe('WorkspaceGuard containment', () => {
  let root: string

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function guard(): Promise<WorkspaceGuard> {
    root = await mkdtemp(join(tmpdir(), 'telegram-fence-'))
    await mkdir(join(root, 'project'))
    return await WorkspaceGuard.fromConfig([root])
  }

  it('accepts a canonical root and its descendants, and refuses anything else', async () => {
    const fence = await guard()
    const canonicalRoot = fence.canonicalRoots[0] as string
    expect(fence.containsCanonical(canonicalRoot)).toBe(true)
    expect(fence.containsCanonical(join(canonicalRoot, 'project'))).toBe(true)
    expect(fence.containsCanonical(join(canonicalRoot, '..'))).toBe(false)
  })

  it('folds case only on Windows', async () => {
    const fence = await guard()
    const shouted = (fence.canonicalRoots[0] as string).toUpperCase()
    expect(fence.containsCanonical(shouted)).toBe(false)
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(fence.containsCanonical(shouted)).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }
  })

  it('reports a canonicalization failure that carries no error code', async () => {
    const fence = await guard()
    await expect(fence.select(join(root, 'codeless-failure'))).rejects.toBeInstanceOf(WorkspaceSelectionError)
    await expect(fence.select(join(root, 'codeless-failure'))).rejects.toThrow(
      /does not resolve to an existing directory$/u,
    )
  })
})
