/** The bundled skill owns its registry candidate and extracted resource directory. */

import { Context } from '@deepseek-ai/cordis'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACL_DIAGNOSIS_SKILL, registerAclDiagnosisSkill, removeStaleAclSkillCopies } from '../src/acl-skill.ts'

const failRemoval = vi.hoisted(() => ({ path: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: (path: string, options: Parameters<typeof actual.rm>[1]) => path === failRemoval.path
      ? Promise.reject(new Error('removal refused'))
      : actual.rm(path, options),
  }
})

/** PID of a process that has already exited. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  if (pid === undefined) throw new Error('Probe process did not start')
  return pid
}

describe('stale ACL skill copy removal', () => {
  let base: string
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'acl-skill-sweep-')) })
  afterEach(() => {
    failRemoval.path = undefined
    vi.restoreAllMocks()
    rmSync(base, { recursive: true, force: true })
  })

  const make = (name: string): string => {
    const path = join(base, name)
    mkdirSync(join(path, 'scripts'), { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), 'body')
    return path
  }

  it('removes copies of exited owners and copies without an owner, keeping everything else', async () => {
    const dead = make(`dsh-acl-skill-${exitedPid()}-Ab12Cd`)
    const unowned = make('dsh-acl-skill-Xy34Zw')
    const live = make(`dsh-acl-skill-${process.pid}-Qr56St`)
    const unrelated = make('dsh-acl-skill-fixture')
    const foreign = make('other-Ab12Cd')
    writeFileSync(join(base, 'dsh-acl-skill-Fi78Le'), 'file')
    const warnings: string[] = []

    await removeStaleAclSkillCopies(base, (message) => { warnings.push(message) })

    expect(existsSync(dead)).toBe(false)
    expect(existsSync(unowned)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(join(base, 'dsh-acl-skill-Fi78Le'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('keeps a symbolic link whose name matches a stale copy', async () => {
    const target = make('target')
    const link = join(base, 'dsh-acl-skill-Li90Nk')
    symlinkSync(target, link, 'junction')

    await removeStaleAclSkillCopies(base, () => {})

    expect(existsSync(link)).toBe(true)
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true)
  })

  it('keeps a copy whose owner runs under another account', async () => {
    const owned = make('dsh-acl-skill-4-Ab12Cd')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    await removeStaleAclSkillCopies(base, () => {})

    expect(existsSync(owned)).toBe(true)
  })

  it('reports scan and removal failures without rejecting', async () => {
    const warnings: string[] = []
    const missing = join(base, 'missing')
    await removeStaleAclSkillCopies(missing, (message) => { warnings.push(message) })
    failRemoval.path = make('dsh-acl-skill-Rm12Fl')
    await removeStaleAclSkillCopies(base, (message) => { warnings.push(message) })

    expect(warnings).toEqual([
      expect.stringContaining(`failed to scan ${missing}`),
      expect.stringContaining(`failed to remove stale skill copy ${failRemoval.path}: Error: removal refused`),
    ])
  })
})

describe('bundled Windows ACL diagnosis skill', () => {
  it('registers the packaged body and removes the candidate on disposal', async () => {
    const ctx = new Context()
    const stale = join(tmpdir(), `dsh-acl-skill-${exitedPid()}-St4lE0`)
    mkdirSync(stale)
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin({
        name: 'acl-skill-registration',
        inject: ['skills'],
        apply: (inner: Context) => { registerAclDiagnosisSkill(inner) },
      })

      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([ACL_DIAGNOSIS_SKILL])
      const entry = catalog[0]!
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeLessThanOrEqual(500)
      expect(entry).toMatchObject({
        source: 'bundled',
        provider: 'dsh-windows-acl',
        invocation: { modelInvocable: true, userInvocable: true },
      })

      const loaded = await ctx.skills.get(ACL_DIAGNOSIS_SKILL)
      expect(loaded?.resourceBase).toMatchObject({ kind: 'directory' })
      if (loaded?.resourceBase?.kind !== 'directory') throw new Error('Missing physical skill resource directory')
      const resourceDirectory = loaded.resourceBase.path
      expect(basename(resourceDirectory)).toMatch(new RegExp(`^dsh-acl-skill-${process.pid}-[A-Za-z0-9]{6}$`, 'u'))
      expect(readFileSync(join(resourceDirectory, 'scripts/diagnose-windows-sandbox-acl.ps1'), 'utf8'))
        .toBe(readFileSync(new URL('../assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1', import.meta.url), 'utf8'))
      // The body names the bundled script — the repair path the model must use
      // instead of editing ACLs by hand.
      expect(loaded?.content).toContain('scripts\\diagnose-windows-sandbox-acl.ps1')
      // Leave room for the tool wrapper below the default 8192-character prune threshold.
      expect(loaded?.content.length).toBeLessThan(7_000)

      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
      expect(existsSync(resourceDirectory)).toBe(false)
      expect(existsSync(stale)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      rmSync(stale, { recursive: true, force: true })
    }
  })

  it('logs a stale copy it cannot remove and still registers', async () => {
    const ctx = new Context()
    const stale = join(tmpdir(), `dsh-acl-skill-${exitedPid()}-Lo6Ged`)
    mkdirSync(stale)
    failRemoval.path = stale
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin({ name: 'acl-skill-stale-warning', inject: ['skills'], apply: registerAclDiagnosisSkill })
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual([ACL_DIAGNOSIS_SKILL])
      await fiber.dispose()
      expect(warnings).toEqual([expect.stringContaining(`failed to remove stale skill copy ${stale}`)])
    } finally {
      failRemoval.path = undefined
      await ctx.fiber.dispose()
      rmSync(stale, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing frontmatter', '# Invalid skill', 'has no YAML frontmatter'],
    ['non-object metadata', '---\nnull\n---\nBody', 'has no description'],
    ['empty description', '---\ndescription: ""\n---\nBody', 'has no description'],
  ])('rejects an extracted skill with %s', async (_name, raw, message) => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin({ name: 'acl-skill-invalid-resource', inject: ['skills'], apply: registerAclDiagnosisSkill })
      const skill = await ctx.skills.get(ACL_DIAGNOSIS_SKILL)
      if (skill?.resourceBase?.kind !== 'directory') throw new Error('Missing physical skill resource directory')
      writeFileSync(join(skill.resourceBase.path, 'SKILL.md'), raw)
      await expect(ctx.skills.get(ACL_DIAGNOSIS_SKILL)).rejects.toThrow(message)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
