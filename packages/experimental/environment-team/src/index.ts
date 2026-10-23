/** Opt-in distributed teams between independently owned Harness Web environments. */
import { stat } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Config, resolveConfig } from './config.ts'
import { installTools } from './tools.ts'
import { loadIdentity } from './identity.ts'
import { EnvironmentTeamsProvider } from './team-dashboard.ts'
import { EnvironmentTeams } from './runtime.ts'
import { DESCRIPTOR_PATH, PEER_PATH, PeerTransport } from './transport.ts'
import { handlePeerSession, handlePeerTerminal, SESSION_FOLLOW_PATH, TERMINAL_FOLLOW_PATH } from './peer-stream.ts'

export { Config } from './config.ts'
/** Cordis plugin identity. */
export const name = 'environment-team'
/** Services needed before exposing peer operations or tools. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'storageDomain', 'tools', 'webServer', 'agentPresets', 'workspaceRegistry', 'credentials']

/**
 * Mount identity discovery, authenticated peer routes, and model-facing team tools.
 * @param ctx - Owning plugin Context.
 * @param input - Deployment-owned peers, workspace mappings, and limits.
 * @returns after persistent state, routes, and tools are ready.
 */
export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = resolveConfig(input)
  const identity = await loadIdentity(config.stateDirectory)
  const transport = new PeerTransport(identity, config, ctx.credentials)
  await transport.tokens()
  for (const [alias, path] of Object.entries(config.workspaces)) {
    if (!(await stat(path)).isDirectory()) throw new Error('configured workspace must be a directory')
    config.workspaces[alias] = (await ctx.workspaceRegistry.create(path)).path
  }
  const release = await lockfile.lock(config.stateDirectory)
  const opening = EnvironmentTeams.open(ctx, identity, config, (id, request, signal) => transport.call(id, request, signal))
  ctx.effect(() => {
    return async () => {
      try { await (await opening).close() } finally { await release() }
    }
  }, 'environmentTeam.runtime')
  const runtime = await opening
  new EnvironmentTeamsProvider(ctx, runtime)
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
  ctx.effect(() => {
    const abort = new AbortController()
    const active = new Set<Promise<void>>()
    const unregister = ctx.webServer.register({ kind: 'exact', path: SESSION_FOLLOW_PATH, handler(request, response) {
      const pending = handlePeerSession(transport, runtime, identity, config, request, response, abort.signal)
      active.add(pending)
      return pending.finally(() => active.delete(pending))
    } })
    return async () => {
      abort.abort()
      unregister()
      await Promise.allSettled([...active])
    }
  }, 'environmentTeam.sessionFollow')
  ctx.effect(() => {
    const abort = new AbortController()
    const active = new Set<Promise<void>>()
    const unregister = ctx.webServer.register({ kind: 'exact', path: TERMINAL_FOLLOW_PATH, handler(request, response) {
      const pending = handlePeerTerminal(transport, runtime, identity, config, request, response, abort.signal)
      active.add(pending)
      return pending.finally(() => active.delete(pending))
    } })
    return async () => { abort.abort(); unregister(); await Promise.allSettled([...active]) }
  }, 'environmentTeam.terminalFollow')
  installTools(ctx, runtime, config)
  ctx.effect(() => {
    const timer = setInterval(() => {
      void runtime.pump().catch(() => { ctx.logger.warn('distributed team retry pass failed') })
    }, config.retryIntervalMs)
    timer.unref()
    return () => { clearInterval(timer) }
  }, 'environmentTeam.retry')
}
