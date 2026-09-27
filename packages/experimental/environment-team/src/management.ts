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
import type { EnvironmentTarget, WorkspaceRequest, WorkspaceResult } from './workspace-types.ts'
import { environmentIdSchema } from './protocol.ts'
import { PeerTransport } from './transport.ts'
import { EnvironmentWorkspaceBrowser } from './workspace-browser.ts'
import { workspaceRequestSchema, workspaceResultSchema } from './workspace-protocol.ts'
import type { SessionRequest, SessionResult, EnvironmentSessionFollowRequest, EnvironmentSessionFrame } from './session-types.ts'
import { sessionRequestSchema, sessionResultSchema, sessionFollowRequestSchema } from './session-protocol.ts'
import { EnvironmentSessions } from './session-service.ts'
import { sessionFrameStream } from './session-stream.ts'

/** Operator-only configuration namespace, separate from peer execution routes. */
export default class EnvironmentTeamSettings extends TypertRemoteService {
  static inject = ['configEditor', 'credentials', 'typert', 'workspaceRegistry', 'agents']

  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'environmentTeamSettings', { namespace: 'environmentTeamSettings' })
    ctx.effect(() => async () => { this.abort.abort(); await Promise.allSettled([...this.pending]) })
  }

  /** Discover configured installations without removing entries whose routes are unavailable.
   * @returns local identity and separately checked peer availability.
   */
  @Remote
  environments(): Promise<EnvironmentTarget[]> {
    return this.track(async () => {
      const { config } = this.entry()
      const id = await loadIdentity(config.stateDirectory)
      const transport = new PeerTransport(id, config, this.ctx.credentials)
      const local: EnvironmentTarget = { environmentId: id, label: config.label, local: true, status: 'online' }
      const peers = await Promise.all(config.peers.map(async (peer) => {
        const environmentId = environmentIdSchema.parse(peer.environmentId)
        try {
          const descriptor = await transport.describe(environmentId, this.abort.signal)
          return { environmentId, label: descriptor.label, local: false, status: descriptor.capabilities.workspaceBrowser ? 'online' : 'unsupported' } satisfies EnvironmentTarget
        } catch {
          // A failed identity check is unavailable, never a substitute registration.
          return { environmentId, label: peer.environmentId, local: false, status: 'unavailable' } satisfies EnvironmentTarget
        }
      }))
      return [local, ...peers]
    })
  }

  /** Run a workspace operation on exactly the selected installation.
   * @param environmentId - installation selected by the operator.
   * @param request - operation relative to a destination-granted directory.
   * @returns destination-validated workspace data; unavailable peers never execute locally.
   */
  @Remote
  workspace(environmentId: EnvironmentTarget['environmentId'], request: WorkspaceRequest): Promise<WorkspaceResult> {
    return this.track(async () => {
      const target = environmentIdSchema.parse(environmentId)
      const operation = workspaceRequestSchema.parse(request)
      const { config } = this.entry()
      const local = await loadIdentity(config.stateDirectory)
      if (target === local) return new EnvironmentWorkspaceBrowser(this.ctx, local, config).run(local, operation)
      const transport = new PeerTransport(local, config, this.ctx.credentials)
      const result = workspaceResultSchema.parse(JSON.parse(await transport.call(target, { kind: 'workspace', environmentId: target, request: operation }, this.abort.signal)))
      const expected = operation.action === 'catalog' ? 'catalog' : operation.action === 'register' ? 'registered' : 'directory'
      if (result.kind !== expected) throw new Error('workspace response action mismatch')
      if (result.kind === 'registered' && result.workspace.environmentId !== target || result.kind === 'catalog' && result.workspaces.some(item => item.environmentId !== target)) throw new Error('workspace environment identity mismatch')
      return result
    })
  }

  /** Run a session operation in its owning environment and registered workspace.
   * @param environmentId - installation selected by the operator.
   * @param request - workspace-scoped session operation.
   * @param signal - operator request cancellation before admission or during reads.
   * @returns validated destination session state; unavailable peers never execute locally.
   */
  @Remote
  session(environmentId: EnvironmentTarget['environmentId'], request: SessionRequest, signal: AbortSignal): Promise<SessionResult> {
    return this.track(async () => {
      const lifetime = AbortSignal.any([signal, this.abort.signal])
      lifetime.throwIfAborted()
      const target = environmentIdSchema.parse(environmentId)
      const operation = sessionRequestSchema.parse(request)
      const { config } = this.entry()
      const local = await loadIdentity(config.stateDirectory)
      lifetime.throwIfAborted()
      if (target === local) return new EnvironmentSessions(this.ctx, local, config).run(local, operation, lifetime)
      const transport = new PeerTransport(local, config, this.ctx.credentials)
      const result = sessionResultSchema.parse(JSON.parse(await transport.call(target, { kind: 'session', environmentId: target, request: operation }, lifetime)))
      const expected = { list: 'sessions', create: 'created', read: 'snapshot', prompt: 'accepted', cancel: 'cancelled' }[operation.action]
      if (result.kind !== expected) throw new Error('session response action mismatch')
      if (result.environmentId !== target || result.workspaceId !== operation.workspaceId) throw new Error('session response destination mismatch')
      if ('sessionId' in operation && 'sessionId' in result && result.sessionId !== operation.sessionId) throw new Error('session response identity mismatch')
      return result
    })
  }

  private entry() {
    const entry = this.ctx.configEditor.entries().find(item => item.options.id === 'environment-team')
    if (!entry?.fiber) throw new Error('Environment teams is not enabled')
    return { entry, fiber: entry.fiber, config: resolveConfig(entry.fiber.config) }
  }

  /** Follow one destination's sanitized Session snapshots through the operator's authenticated connection.
   * @param environmentId - installation selected by the operator.
   * @param request - registered workspace and Session identities.
   * @param signal - operator stream cancellation.
   * @returns replacement snapshots; destination failures never select a local Session.
   */
  @Remote({ mode: 'stream' })
  sessionFollow(environmentId: EnvironmentTarget['environmentId'], request: EnvironmentSessionFollowRequest, signal: AbortSignal): AsyncIterable<EnvironmentSessionFrame> {
    const { fiber, config } = this.entry()
    const owner = new AbortController()
    let done = Promise.resolve()
    let settled = false
    const release = fiber.effect(() => async () => { if (!settled) { owner.abort(); await done } }, 'environmentTeamSettings.follow')
    const lifetime = AbortSignal.any([signal, this.abort.signal, owner.signal])
    const open = async function* (this: EnvironmentTeamSettings, active: AbortSignal): AsyncIterable<EnvironmentSessionFrame> {
      active.throwIfAborted()
      const target = environmentIdSchema.parse(environmentId)
      const operation = sessionFollowRequestSchema.parse(request)
      const local = await loadIdentity(config.stateDirectory)
      active.throwIfAborted()
      if (target === local) yield* new EnvironmentSessions(this.ctx, local, config).follow(local, operation, active)
      else yield* new PeerTransport(local, config, this.ctx.credentials).follow(target, operation, active)
    }
    const stream = sessionFrameStream(active => open.call(this, active), lifetime)
    done = stream.done
    void done.then(() => { settled = true; void release() })
    this.pending.add(stream.done)
    void stream.done.then(() => this.pending.delete(stream.done))
    return stream.frames
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

  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('environment management is closed'))
    const operation = run()
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
}
