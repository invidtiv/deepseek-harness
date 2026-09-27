/** Two isolated real HTTP installations with one pairwise Session grant. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { sessionHost } from './session-host.ts'
import * as Plugin from '../src/index.ts'
import type { ResolvedConfig } from '../src/config.ts'

/**
 * Mount paired destination routes over allocator-owned loopback ports.
 * @param own - registers each host cleanup immediately after acquisition.
 * @param overrides - test-specific stream deadlines and response limits.
 * @returns caller, destination, and the fixture-only bearer secret.
 */
export async function pairedSessionHosts(own: (close: () => Promise<void>) => void, overrides: Partial<ResolvedConfig> = {}) {
  const caller = await sessionHost()
  own(caller.close)
  const destination = await sessionHost()
  own(destination.close)
  const token = randomUUID() + randomUUID()
  for (const [host, peer] of [[caller, destination], [destination, caller]] as const) {
    Object.assign(host.config, overrides)
    await host.ctx.plugin(Credentials, { path: join(host.root, 'credentials.yml'), watch: false })
    await host.ctx.credentials.set(credentialRef('SESSION_PAIR'), token)
    host.config.peers.push({ environmentId: peer.id, url: peer.url, tokenEnv: 'SESSION_PAIR', workspaces: ['project'], workspaceManagement: true, sessionAccess: true })
    await host.ctx.plugin(Plugin, host.config)
  }
  return { caller, destination, token }
}
