/**
 * Path canonicalization for workspace identity.
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Check whether a path names one fixed Host location without process cwd or
 * current-drive resolution.
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is fully qualified on that platform.
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Check whether a path is absolute in the execution world: POSIX-absolute, or
 * a fully qualified Windows path. The two forms cannot be told apart from the
 * string alone, so a path acceptable to either world passes; the composed
 * filesystem resolves it in the world that actually owns it.
 * @param path - Candidate Workspace path.
 * @returns Whether the path is absolute in either execution world.
 */
export function absoluteWorkspacePath(path: string): boolean {
  return posix.isAbsolute(path) || fullyQualifiedWorkspacePath(path, 'win32')
}

/**
 * Derive a non-empty default title from a canonical Workspace path.
 * @param path - Canonical Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns The final segment when present, otherwise the complete root spelling.
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * Canonicalize a fully qualified path on the HARNESS HOST via `fs.realpath`:
 * trailing slashes, `..` segments, and symlinks are all resolved. The
 * workspace registry canonicalizes through `ctx.fs` in each workspace's
 * execution world instead; this helper serves callers that address the Harness
 * host directly (for example the Telegram frontend's workspace roots). Relative
 * paths reject before `realpath` can resolve them from the Host cwd or current
 * Windows drive. A path that does not exist rejects with the original
 * `ENOENT`.
 * @param path - The path to canonicalize.
 * @returns the canonical absolute path.
 */
export async function realpathNormalize(path: string): Promise<string> {
  if (!fullyQualifiedWorkspacePath(path)) {
    throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
  }
  return await realpath(path)
}
