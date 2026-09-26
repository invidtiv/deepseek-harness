/** Opt-in distributed teams between independently owned Harness Web environments. */
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Config, resolveConfig } from './config.ts'
import { installTools } from './tools.ts'
import { loadIdentity } from './identity.ts'
import { EnvironmentTeams } from './runtime.ts'
import { DESCRIPTOR_PATH, PEER_PATH, PeerTransport } from './transport.ts'

export { Config } from './config.ts'
/** Cordis plugin identity. */
export const name = 'environment-team'
/** Services needed before exposing peer operations or tools. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'storageDomain', 'tools', 'webServer', 'agentPresets', 'workspaceRegistry']

/**
 * Mount identity discovery, authenticated peer routes, and model-facing team tools.
 * @param ctx - Owning plugin Context.
 * @param input - Deployment-owned peers, workspace mappings, and limits.
 * @returns after persistent state, routes, and tools are ready.
 */
export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = resolveConfig(input)
  const identity = await loadIdentity(config.stateDirectory)
  const transport = new PeerTransport(identity, config)
  for (const [alias, path] of Object.entries(config.workspaces)) {
    if (!(await stat(path)).isDirectory()) throw new Error('configured workspace must be a directory')
    config.workspaces[alias] = (await ctx.workspaceRegistry.create(path)).path
  }
  const release = await lockfile.lock(config.stateDirectory)
  const opening = EnvironmentTeams.open(ctx, identity, config, (id, request, signal) => transport.call(id, request, signal))
  ctx.effect(() => {
    const disposeProjection = ctx.sessionProjections.register({
      key: 'environmentTeamReceipts', stateVersion: 1,
      stateSchema: z.array(z.string().transform(value => brandString<MessageId>(value))).readonly(),
      init: (): readonly MessageId[] => [],
      apply(state: readonly MessageId[], event) {
        if (event.type !== 'agent/inbox/spliced' || event.data.inserted.length === 0) return state
        const received = event.data.inserted.filter(message => message.id.startsWith('envteam:')).map(message => message.id)
        return received.length === 0 ? state : [...new Set([...state, ...received])]
      },
    })
    return async () => {
      try { await (await opening).close() } finally { disposeProjection(); await release() }
    }
  }, 'environmentTeam.runtime')
  const runtime = await opening
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: DESCRIPTOR_PATH,
    handler(request, response) {
      if (request.method !== 'GET') { response.writeHead(405).end(); return }
      response.setHeader('content-type', 'application/json')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify(runtime.descriptor()))
    },
  }), 'environmentTeam.descriptor')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PEER_PATH, handler: (request, response) => transport.handle(runtime, request, response) }), 'environmentTeam.peer')
  installTools(ctx, runtime, config)
  ctx.effect(() => {
    const timer = setInterval(() => {
      void runtime.pump().catch(() => { ctx.logger.warn('distributed team retry pass failed') })
    }, config.retryIntervalMs)
    timer.unref()
    return () => { clearInterval(timer) }
  }, 'environmentTeam.retry')
}
