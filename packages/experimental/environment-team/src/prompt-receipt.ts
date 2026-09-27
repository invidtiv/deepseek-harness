/** Durable retry fingerprints for prompts whose staged upload receipts can expire. */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionRequest } from './session-types.ts'
import type { EnvironmentId } from './protocol.ts'

/**
 * Pin one attachment submission before admission without retaining file bytes or secrets.
 * @param directory - environment-owned state directory.
 * @param environment - durable destination identity.
 * @param request - validated prompt with its stable retry identifier.
 * @param alreadyAccepted - whether an older message owns the identifier without this receipt.
 */
export async function pinAttachmentPrompt(directory: string, environment: EnvironmentId, request: Extract<SessionRequest, { action: 'prompt' }>, alreadyAccepted: boolean): Promise<void> {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const key = digest(JSON.stringify([environment, request.workspaceId, request.sessionId, request.requestId]))
  const images = (request.images ?? []).map(image => [image.mediaType, image.name ?? null, image.data])
  const fingerprint = digest(JSON.stringify([request.text, request.attachments ?? [], images]))
  const root = join(directory, 'prompt-receipts')
  const path = join(root, key)
  const verify = (stored: string) => {
    if (stored !== `${fingerprint}\n`) throw new Error('prompt retry identity has different content')
  }
  try { verify(await readFile(path, 'utf8')); return } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (alreadyAccepted) throw new Error('prompt retry identity has different content')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temporary = join(root, `.pending-${randomUUID()}`)
  await writeFile(temporary, `${fingerprint}\n`, { flag: 'wx', mode: 0o600 })
  try {
    try { await link(temporary, path) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    verify(await readFile(path, 'utf8'))
  } finally { await unlink(temporary) }
}
