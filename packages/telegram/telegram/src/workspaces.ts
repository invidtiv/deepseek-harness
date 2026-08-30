/**
 * Workspace-root authorization: the plugin's read-side filesystem fence.
 *
 * Every selection must be absolute, resolve to an existing directory through
 * the same `fs.realpath` canon the workspace registry uses, and land inside a
 * configured root by canonical-path containment. The harness sandbox confines
 * the session's writes under the same path; this guard is what keeps the rest
 * of the disk unreadable, so it is load-bearing, not redundant.
 * @module @deepseek-ai/dsh-telegram/src/workspaces
 */

import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

/** A workspace selection failed validation; the message is user-presentable and names no internals. */
export class WorkspaceSelectionError extends Error {
  /**
   * @param message - User-facing reason.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceSelectionError'
  }
}

/** Canonical containment test with Windows case folding. */
function isInside(root: string, candidate: string): boolean {
  const rootFold = process.platform === 'win32' ? root.toLowerCase() : root
  const candidateFold = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const rel = relative(rootFold, candidateFold)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Allowlisted workspace roots. Roots are canonicalized once at startup (a
 * missing root fails load); selections canonicalize per request and must
 * contain-match one root. No environment-variable or tilde expansion happens
 * anywhere; UNC roots work only when a UNC root is explicitly configured.
 */
export class WorkspaceGuard {
  private readonly roots: readonly string[]

  /**
   * @param roots - Configured roots; the caller validates non-emptiness, this canonicalizes each.
   */
  constructor(roots: readonly string[]) {
    this.roots = roots
  }

  /** The canonical configured roots, for `/folder` option rendering. */
  get canonicalRoots(): readonly string[] {
    return this.roots
  }

  /**
   * Canonicalize the configured roots. Fails load on a missing or
   * non-directory root — misconfiguration is loud at boot, not at first use.
   * @param roots - Configured absolute root directories, in config order.
   * @returns a guard carrying canonical roots.
   */
  static async fromConfig(roots: readonly string[]): Promise<WorkspaceGuard> {
    const canonical: string[] = []
    for (const root of roots) {
      const path = await WorkspaceGuard.canonicalize(root)
      canonical.push(path)
    }
    return new WorkspaceGuard(canonical)
  }

  /**
   * Canonicalize one absolute path, rejecting non-absolute input, missing
   * paths, and non-directories. This is the only canon the plugin stores.
   * @param path - User- or config-supplied absolute path.
   * @returns the canonical absolute path.
   */
  static async canonicalize(path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new WorkspaceSelectionError(`workspace must be an absolute path: ${path}`)
    }
    let canonical: string
    try {
      canonical = await realpathNormalize(path)
    } catch (error) {
      const detail = error instanceof Error && 'code' in error ? ` (${String(error.code)})` : ''
      throw new WorkspaceSelectionError(`workspace '${path}' does not resolve to an existing directory${detail}`)
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new WorkspaceSelectionError(`workspace '${canonical}' is not a directory`)
    }
    return canonical
  }

  /**
   * Validate one selection end to end: canonicalize, then require canonical
   * containment inside a configured root.
   * @param path - User-supplied absolute path.
   * @returns the canonical absolute path inside an allowed root.
   */
  async select(path: string): Promise<string> {
    const canonical = await WorkspaceGuard.canonicalize(path)
    if (!this.roots.some(root => isInside(root, canonical))) {
      throw new WorkspaceSelectionError(
        `workspace '${canonical}' is outside the configured workspace roots`,
      )
    }
    return canonical
  }

  /**
   * Whether an already-canonical path sits inside an allowed root.
   * @param canonical - A path already resolved by {@link WorkspaceGuard.canonicalize}; nothing is re-resolved here.
   * @returns `true` when the path is a configured root or sits under one.
   */
  containsCanonical(canonical: string): boolean {
    return this.roots.some(root => isInside(root, canonical))
  }
}
