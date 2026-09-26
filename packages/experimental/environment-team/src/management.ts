/** Authenticated operator editing of the environment-team plugin's profile configuration. */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolveConfig } from './config.ts'
import { loadIdentity } from './identity.ts'
import type { EnvironmentConfiguration } from './settings-types.ts'

/** Operator-only configuration namespace, separate from peer execution routes. */
export default class EnvironmentTeamSettings extends TypertRemoteService {
  static inject = ['configEditor', 'credentials', 'typert']

  constructor(ctx: Context) { super(ctx, 'environmentTeamSettings', { namespace: 'environmentTeamSettings' }) }

  private entry() {
    const entry = this.ctx.configEditor.entries().find(item => item.options.id === 'environment-team')
    if (!entry?.fiber) throw new Error('Environment teams is not enabled')
    return { entry, config: resolveConfig(entry.fiber.config) }
  }

  /** Read editable configuration and public identity without credential values.
   * @returns current configuration with its optimistic-write revision.
   */
  @Remote
  async read(): Promise<EnvironmentConfiguration> {
    const { entry, config } = this.entry()
    return { config, revision: this.revision(entry.options.config), environmentId: await loadIdentity(config.stateDirectory) }
  }

  /** Validate and persist one complete deployment configuration.
   * @param input - values and revision read by the operator's form.
   * @returns the saved configuration after the runtime has reloaded.
   */
  @Remote
  async save(input: EnvironmentConfiguration): Promise<EnvironmentConfiguration> {
    const config = resolveConfig(input.config)
    const { entry, config: previous } = this.entry()
    if (config.stateDirectory !== previous.stateDirectory) throw new Error('Environment identity storage cannot be moved from this page')
    for (const path of Object.values(config.workspaces)) {
      if (!(await stat(path)).isDirectory()) throw new Error('Workspace must be an existing local directory')
    }
    const secrets = new Set<string>()
    const id = await loadIdentity(config.stateDirectory)
    for (const peer of config.peers) {
      if (peer.environmentId === id) throw new Error('An environment cannot pair with itself')
      const secret = (await this.ctx.credentials.resolve(credentialRef(peer.tokenEnv)))?.value
      if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Save a pairing secret of at least 32 bytes for each peer')
      if (secrets.has(secret)) throw new Error('Use a different pairing secret for each peer')
      secrets.add(secret)
    }
    await this.ctx.configEditor.edit(entry, (current) => {
      if (this.revision(current) !== input.revision) throw new Error('Configuration changed; reload before saving')
      return { ...config }
    })
    return this.read()
  }

  private revision(value: unknown): EnvironmentConfiguration['revision'] {
    return brandString<EnvironmentConfiguration['revision']>(createHash('sha256').update(JSON.stringify({ config: value })).digest('hex'))
  }
}
