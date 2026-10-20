/**
 * Registers the bundled Windows sandbox ACL diagnosis skill.
 *
 * The provider owns a private filesystem copy of its resources so external
 * PowerShell can execute them even when the package lives inside ASAR or SEA.
 * Disposing the registration removes both the provider and its resource copy.
 * Registration also removes copies left by processes that exited without
 * disposing it.
 *
 * @module @deepseek-ai/dsh-sandbox-windows-acl
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Bundled skill that diagnoses Windows sandbox ACL failures. */
export const ACL_DIAGNOSIS_SKILL = 'diagnose-windows-sandbox-acl'

/** Provider name this module registers the skill under. */
const PROVIDER = 'dsh-windows-acl'

/** Temporary-directory prefix of every resource copy. */
const DIRECTORY_PREFIX = 'dsh-acl-skill-'

/** A resource copy named by its owner process: prefix, owner PID, and the `mkdtemp` suffix. */
const OWNED_DIRECTORY_RE = new RegExp(`^${DIRECTORY_PREFIX}(\\d+)-[A-Za-z0-9]{6}$`, 'u')

/** A resource copy created before copies recorded their owner PID. */
const UNOWNED_DIRECTORY_RE = new RegExp(`^${DIRECTORY_PREFIX}[A-Za-z0-9]{6}$`, 'u')

/** Report whether `pid` names a running process; `EPERM` means it runs under another account. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * Remove resource copies under `base` whose owner process no longer runs, and copies
 * without an owner PID. Copies of running processes, other names, and symbolic links stay.
 * Failures are reported to `warn` and never reject.
 * @param base - Directory holding resource copies.
 * @param warn - Sink for contained filesystem failures.
 * @returns Resolves after every stale copy was removed or reported.
 */
export async function removeStaleAclSkillCopies(base: string, warn: (message: string) => void): Promise<void> {
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch (error: unknown) {
    warn(`dsh-sandbox-windows-acl: failed to scan ${base} for stale skill copies: ${String(error)}`)
    return
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return
    const owner = OWNED_DIRECTORY_RE.exec(entry.name)?.[1]
    if (owner === undefined ? !UNOWNED_DIRECTORY_RE.test(entry.name) : isProcessRunning(Number(owner))) return
    const path = join(base, entry.name)
    try {
      await rm(path, { recursive: true, force: true })
    } catch (error: unknown) {
      warn(`dsh-sandbox-windows-acl: failed to remove stale skill copy ${path}: ${String(error)}`)
    }
  }))
}

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`dsh-sandbox-windows-acl: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description
    : undefined
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`dsh-sandbox-windows-acl: ${path} has no description`)
  }
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Register the bundled diagnosis skill with a private resource directory owned by this fiber.
 * Missing or invalid packaged assets fail registration; disposal removes the directory.
 * Registration starts {@link removeStaleAclSkillCopies} without awaiting it; disposal awaits it.
 * @param ctx - Context carrying the skill registry.
 */
export function registerAclDiagnosisSkill(ctx: Context): void {
  const packaged = fileURLToPath(new URL(`../assets/${ACL_DIAGNOSIS_SKILL}/`, import.meta.url))
  ctx.effect(function* () {
    const sweep = removeStaleAclSkillCopies(tmpdir(), (message) => { ctx.logger.warn(message) })
    yield async () => { await sweep }
    const directory = mkdtempSync(join(tmpdir(), `${DIRECTORY_PREFIX}${process.pid}-`))
    yield async () => { await rm(directory, { recursive: true, force: true }) }
    mkdirSync(join(directory, 'scripts'))
    for (const path of ['SKILL.md', 'scripts/diagnose-windows-sandbox-acl.ps1']) {
      writeFileSync(join(directory, path), readFileSync(join(packaged, path)), { flag: 'wx', mode: 0o600 })
    }
    const locator = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
    const candidate: SkillCandidate = {
      name: ACL_DIAGNOSIS_SKILL,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator,
    }
    const provider: SkillProvider = {
      name: PROVIDER,
      list: () => Promise.resolve([candidate]),
      async get(entry, options) {
        const { rank: _rank, locator: entryPath, ...summary } = entry
        const raw = await readFile(entryPath as string, { encoding: 'utf8', signal: options.signal })
        return { ...summary, content: parseSkill(raw, entryPath as string).content }
      },
    }
    yield ctx.skills.registerProvider(() => provider)
  }, 'Windows ACL diagnosis skill resources')
}
