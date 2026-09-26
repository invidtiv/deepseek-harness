/** Route-independent identity published without replacing an existing identity. */
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { environmentIdSchema, type EnvironmentId } from './protocol.ts'

/**
 * Load or atomically publish one environment UUID. Concurrent initializers read the winner.
 * @param directory - Deployment-owned local state directory, never shared between machines.
 * @returns the validated persisted identity; corrupt existing files reject without replacement.
 */
export async function loadIdentity(directory: string): Promise<EnvironmentId> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'environment-id')
  try {
    return environmentIdSchema.parse((await readFile(path, 'utf8')).trim())
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const temporary = join(directory, `.identity-${randomUUID()}`)
  await writeFile(temporary, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 })
  try {
    try {
      await link(temporary, path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    return environmentIdSchema.parse((await readFile(path, 'utf8')).trim())
  } finally {
    await unlink(temporary)
  }
}
