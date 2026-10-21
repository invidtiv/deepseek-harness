/** Revision-checked configuration commits stage new credentials without mutating active references. */
import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-config-editor'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveConfig, type ResolvedConfig } from './config.ts'
import { loadIdentity } from './identity.ts'
import { pairingCredentialChangesSchema } from './pairing-protocol.ts'
import type { PairingCredentialChange } from './pairing-types.ts'
import type { EnvironmentConfiguration } from './settings-types.ts'

const queues = new Map<string, Promise<void>>()

/** Hash raw persisted configuration for optimistic operator edits.
 * @param value - raw Loader configuration.
 * @returns stable revision for this exact configuration.
 */
export function environmentConfigurationRevision(value: unknown): EnvironmentConfiguration['revision'] {
  return brandString<EnvironmentConfiguration['revision']>(createHash('sha256').update(JSON.stringify({ config: value })).digest('hex'))
}

/** Resolve the enabled runtime configuration without taking ownership of its storage.
 * @param ctx - authenticated profile management context.
 * @returns current Loader entry and resolved values.
 */
export function environmentConfigurationEntry(ctx: Context): { entry: Entry; fiber: Fiber; config: ResolvedConfig } {
  const entry = ctx.configEditor.entries().find(item => item.options.id === 'environment-team')
  if (!entry?.fiber) throw new Error('Environment teams is not enabled')
  const fiber = entry.fiber
  const raw: unknown = entry.options.config
  const resolved: unknown = fiber.config ?? fiber.ctx.waterfall(fiber, 'internal/config', raw, () => raw)
  return { entry, fiber, config: resolveConfig(resolved) }
}

/** Read public configuration and identity without exposing credential values.
 * @param ctx - authenticated profile management context.
 * @returns editable configuration with optimistic revision.
 */
export async function readEnvironmentConfiguration(ctx: Context): Promise<EnvironmentConfiguration> {
  const { entry, config } = environmentConfigurationEntry(ctx)
  return {
    config, revision: environmentConfigurationRevision(entry.options.config), environmentId: await loadIdentity(config.stateDirectory),
  }
}

/** Commit a configuration and write-only credential changes as one compensated operation.
 * @param ctx - authenticated profile management context.
 * @param input - complete config and its observed revision.
 * @param changes - replacement secrets keyed by intended peer identity.
 * @returns reloaded configuration; failed commits retain all previous credential references.
 */
export async function saveEnvironmentConfiguration(
  ctx: Context, input: EnvironmentConfiguration, changes: PairingCredentialChange[],
): Promise<EnvironmentConfiguration> {
  const config = resolveConfig(input.config)
  const parsed = pairingCredentialChangesSchema.parse(changes)
  const previous = queues.get(config.stateDirectory) ?? Promise.resolve()
  const work = previous.then(async () => {
    const { entry, config: before } = environmentConfigurationEntry(ctx)
    if (config.stateDirectory !== before.stateDirectory) throw new Error('Environment identity storage cannot be moved from this page')
    if (environmentConfigurationRevision(entry.options.config) !== input.revision) throw new Error('Configuration changed; reload before saving')
    const id = await loadIdentity(config.stateDirectory)
    if (input.environmentId !== id) throw new Error('Configuration environment identity mismatch')
    if (new Set(parsed.map(item => item.environmentId)).size !== parsed.length) throw new Error('Duplicate peer credential change')
    for (const change of parsed) {
      if (!config.peers.some(peer => peer.environmentId === change.environmentId)) throw new Error('Credential change has no configured peer')
    }
    for (const path of Object.values(config.workspaces)) {
      if (!(await stat(path)).isDirectory()) throw new Error('Workspace must be an existing local directory')
    }
    const staged: string[] = []
    try {
      const secrets = new Set<string>()
      for (const peer of config.peers) {
        if (peer.environmentId === id) throw new Error('An environment cannot pair with itself')
        const change = parsed.find(item => item.environmentId === peer.environmentId)
        const secret = change?.secret ?? (await ctx.credentials.resolve(credentialRef(peer.tokenEnv)))?.value
        if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Save a pairing secret of at least 32 bytes for each peer')
        if (secrets.has(secret)) throw new Error('Use a different pairing secret for each peer')
        secrets.add(secret)
        if (change) {
          const reference = `DSH_PAIR_${randomUUID().replaceAll('-', '_')}`
          staged.push(reference)
          await ctx.credentials.set(credentialRef(reference), secret)
          peer.tokenEnv = reference
        }
      }
      await ctx.configEditor.edit(entry, (current) => {
        if (environmentConfigurationRevision(current) !== input.revision) throw new Error('Configuration changed; reload before saving')
        return { ...config }
      })
    } catch (error) {
      // A failed rollback may leave a committed reference; preserve any credential still selected by the Loader.
      const references = new Set(environmentConfigurationEntry(ctx).config.peers.map(peer => peer.tokenEnv))
      const cleanup = await Promise.allSettled(staged.filter(reference => !references.has(reference))
        .map(reference => ctx.credentials.unset(credentialRef(reference))))
      const failures = cleanup.filter(item => item.status === 'rejected').map((item): unknown => item.reason)
      if (failures.length) throw new AggregateError([error, ...failures], 'Configuration failed and staged credential cleanup failed')
      throw error
    }
    return readEnvironmentConfiguration(ctx)
  })
  const settled = work.then(() => undefined, () => undefined)
  queues.set(config.stateDirectory, settled)
  try { return await work } finally { if (queues.get(config.stateDirectory) === settled) queues.delete(config.stateDirectory) }
}
