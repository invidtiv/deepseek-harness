/** Authenticated operator editing of the environment-team plugin's profile configuration. */
import type { EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from './interaction-types.ts'
import { terminalFollowRequestSchema } from './interaction-protocol.ts'
import { terminalFrameStream } from './terminal-stream.ts'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './team-dashboard.ts'
import { teamDashboardRequestSchema, teamDashboardResultSchema } from './team-dashboard-protocol.ts'
import type { TeamDashboardRequest, TeamDashboardResult } from './team-types.ts'
import type {} from './pairing.ts'
import { environmentConfigurationEntry, readEnvironmentConfiguration, saveEnvironmentConfiguration } from './pairing-configuration.ts'
import type { PairingGrants, PairingInvitation, PairingInvitationMetadata, PairingInvitationId, PairingReceipt, PairingCredentialChange, PairingAttemptMetadata } from './pairing-types.ts'
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
import { EnvironmentSessionInteractions } from './session-interactions.ts'
import { interactionRequestSchema, interactionResultSchema } from './interaction-protocol.ts'
import type { EnvironmentInteractionRequest, EnvironmentInteractionResult } from './interaction-types.ts'
import { TerminalInputRoutes } from './terminal-input.ts'

/** Operator-only configuration namespace, separate from peer execution routes. */
export default class EnvironmentTeamSettings extends TypertRemoteService {
  static inject = ['configEditor', 'credentials', 'typert', 'workspaceRegistry', 'agents']

  private readonly abort = new AbortController()
  private readonly terminalInputs = new TerminalInputRoutes()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'environmentTeamSettings', { namespace: 'environmentTeamSettings' })
    ctx.effect(() => async () => { this.abort.abort(); await Promise.allSettled([...this.pending]) })
  }

  /** Read or operate the selected coordinator using operator authority.
   * @param environmentId - explicit coordinator identity.
   * @param request - catalog, read, or member interruption.
   * @param signal - caller cancellation.
   * @returns validated data from the selected coordinator.
   */
  @Remote
  teamDashboard(environmentId: EnvironmentTarget['environmentId'], request: TeamDashboardRequest, signal: AbortSignal): Promise<TeamDashboardResult> {
    return this.track(async () => {
      const target = environmentIdSchema.parse(environmentId)
      const operation = teamDashboardRequestSchema.parse(request)
      const { config } = this.entry()
      const local = await loadIdentity(config.stateDirectory)
      const lifetime = AbortSignal.any([signal, this.abort.signal])
      lifetime.throwIfAborted()
      if (target === local) {
        const provider = this.ctx.get('environmentTeams')
        if (!provider || provider.runtime.environmentId !== local) throw new Error('team runtime is unavailable')
        return provider.runtime.dashboard(local, operation, lifetime)
      }
      const transport = new PeerTransport(local, config, this.ctx.credentials)
      const descriptor = await transport.describe(target, lifetime)
      if (!descriptor.capabilities.teamDashboard) throw new Error('peer team dashboard is unsupported')
      const result = teamDashboardResultSchema.parse(JSON.parse(await transport.call(target,
        { kind: 'team-dashboard', environmentId: target, request: operation }, lifetime)))
      const expected = operation.action === 'read' ? 'team' : operation.action === 'interrupt' ? 'interrupted' : 'catalog'
      if (result.environmentId !== target || result.kind !== expected) throw new Error('team dashboard response mismatch')
      if (operation.action !== 'catalog' && (result.kind === 'catalog' || result.teamId !== operation.teamId)) {
        throw new Error('team dashboard identity mismatch')
      }
      if (operation.action === 'interrupt' && result.kind === 'interrupted' && result.sessionId !== operation.sessionId) {
        throw new Error('team dashboard member mismatch')
      }
      return result
    })
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
      const before = operation.action === 'list' ? operation.before : undefined
      if (before !== undefined && result.kind === 'sessions' && result.sessions.some(session =>
        session.updatedAt > before.updatedAt || (session.updatedAt === before.updatedAt && session.sessionId >= before.sessionId))) {
        throw new Error('session catalog response exceeds requested range')
      }
      const beforeSeq = operation.action === 'read' ? operation.beforeSeq : undefined
      if (beforeSeq !== undefined && result.kind === 'snapshot' && result.messages.some(message => message.seq >= beforeSeq)) throw new Error('session history response exceeds requested range')
      return result
    })
  }

  private entry() { return environmentConfigurationEntry(this.ctx) }

  /** Operate on files, human requests, or terminals owned by the selected Session.
   * @param environmentId - explicit destination identity.
   * @param request - workspace-scoped interaction with destination-owned identifiers.
   * @param signal - operator cancellation.
   * @returns a validated response from the exact destination Session.
   */
  @Remote
  sessionInteraction(environmentId: EnvironmentTarget['environmentId'], request: EnvironmentInteractionRequest, signal: AbortSignal): Promise<EnvironmentInteractionResult> {
    return this.track(async () => {
      const lifetime = AbortSignal.any([signal, this.abort.signal])
      lifetime.throwIfAborted()
      const target = environmentIdSchema.parse(environmentId)
      const operation = interactionRequestSchema.parse(request)
      const { config } = this.entry()
      const local = await loadIdentity(config.stateDirectory)
      if (target === local) {
        return new EnvironmentSessionInteractions(this.ctx, local, config, this.terminalInputs).run(local, operation, lifetime)
      }
      const transport = new PeerTransport(local, config, this.ctx.credentials)
      const descriptor = await transport.describe(target, lifetime)
      if (!descriptor.capabilities.workspaceSessionInteractions) throw new Error('Peer does not support Session interactions')
      const result = interactionResultSchema.parse(JSON.parse(await transport.call(target, { kind: 'session-interaction', environmentId: target, request: operation }, lifetime)))
      const expected = operation.action === 'snapshot' ? 'snapshot' : operation.action === 'upload' ? 'uploaded' : operation.action === 'download' ? 'download' : operation.action === 'terminal-create' ? 'terminal' : 'acknowledged'
      if (result.environmentId !== target || result.workspaceId !== operation.workspaceId || result.sessionId !== operation.sessionId || result.kind !== expected) throw new Error('Session interaction response mismatch')
      if (operation.action === 'download' && result.kind === 'download' && result.attachment.attachmentId !== operation.attachmentId) throw new Error('Attachment response mismatch')
      if (operation.action === 'terminal-create' && result.kind === 'terminal' && result.terminal.id !== operation.request.id) throw new Error('Terminal response mismatch')
      return result
    })
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

  /** Follow ordered output from the selected destination terminal.
   * @param environmentId - installation selected by the operator.
   * @param request - ordinary Session, terminal and exclusive input attachment.
   * @param signal - physical viewer cancellation.
   * @returns ordered terminal frames; reconnect obtains a fresh recovery screen.
   */
  @Remote({ mode: 'stream' })
  terminalFollow(environmentId: EnvironmentTarget['environmentId'], request: EnvironmentTerminalFollowRequest, signal: AbortSignal): AsyncIterable<EnvironmentTerminalFrame> {
    const { fiber, config } = this.entry()
    const owner = new AbortController()
    let done = Promise.resolve()
    let settled = false
    const release = fiber.effect(() => async () => { if (!settled) { owner.abort(); await done } }, 'environmentTeamSettings.terminalFollow')
    const lifetime = AbortSignal.any([signal, this.abort.signal, owner.signal])
    const open = async function* (this: EnvironmentTeamSettings, active: AbortSignal): AsyncIterable<EnvironmentTerminalFrame> {
      active.throwIfAborted()
      const target = environmentIdSchema.parse(environmentId)
      const operation = terminalFollowRequestSchema.parse(request)
      const local = await loadIdentity(config.stateDirectory)
      active.throwIfAborted()
      if (target === local) {
        yield* new EnvironmentSessionInteractions(this.ctx, local, config, this.terminalInputs).followTerminal(local, operation, active)
      }
      else yield* new PeerTransport(local, config, this.ctx.credentials).terminalFollow(target, operation, active)
    }
    const stream = terminalFrameStream(active => open.call(this, active), lifetime, config.maxBytes)
    done = stream.done
    void done.then(() => { settled = true; void release() })
    this.pending.add(done)
    void done.then(() => this.pending.delete(done))
    return stream.frames
  }

  /** Read editable configuration and public identity without credential values.
   * @returns current configuration with its optimistic-write revision.
   */
  @Remote
  read(): Promise<EnvironmentConfiguration> { return readEnvironmentConfiguration(this.ctx) }

  /** Persist complete configuration without changing credential values.
   * @param input - values and revision read by the operator.
   * @returns reloaded configuration.
   */
  @Remote
  save(input: EnvironmentConfiguration): Promise<EnvironmentConfiguration> {
    return this.track(() => saveEnvironmentConfiguration(this.ctx, input, []))
  }

  /** Save write-only peer secrets together with their optimistic configuration edit.
   * @param input - complete edited configuration and observed revision.
   * @param changes - replacement credentials keyed by configured peer identity.
   * @returns saved configuration containing fresh credential references only.
   */
  @Remote
  saveWithCredentials(input: EnvironmentConfiguration, changes: PairingCredentialChange[]): Promise<EnvironmentConfiguration> {
    return this.track(() => saveEnvironmentConfiguration(this.ctx, input, changes))
  }

  /** Generate a one-time pairing code with explicit local permissions.
   * @param grants - local permissions delegated to that peer.
   * @returns one-time private invitation envelope.
   */
  @Remote
  pairingCreate(grants: PairingGrants): Promise<PairingInvitation> {
    return this.track(() => this.pairing().create(grants))
  }

  /** Read invitation metadata without secret material.
   * @returns local invitation inventory.
   */
  @Remote
  pairingList(): Promise<PairingInvitationMetadata[]> { return this.track(() => this.pairing().list()) }

  /** Revoke an unconsumed invitation.
   * @param id - selected invitation identity.
   */
  @Remote
  pairingRevoke(id: PairingInvitationId): Promise<void> { return this.track(() => this.pairing().revoke(id)) }

  /** Complete both sides of invitation pairing with explicit local grants.
   * @param invitation - private envelope issued for this installation.
   * @param grants - local permissions delegated to the issuer.
   * @returns identity acknowledgment after both peer configurations are committed.
   */
  @Remote
  pairingAccept(invitation: PairingInvitation, grants: PairingGrants): Promise<PairingReceipt> {
    return this.track(() => this.pairing().accept(invitation, grants))
  }

  /** Import a privately transferred invitation envelope.
   * @param invitation - code copied from the target machine, or a legacy JSON invitation.
   * @param grants - explicitly selected local permissions for that issuer.
   * @returns acknowledgment after both peer configurations are committed.
   */
  @Remote
  pairingImport(invitation: string, grants: PairingGrants): Promise<PairingReceipt> {
    return this.track(async () => {
      const code = invitation.trim()
      if (Buffer.byteLength(code) > this.entry().config.maxBytes) throw new Error('Pairing code is too large')
      const json = code.startsWith('dsh-pair:') ? Buffer.from(code.slice(9), 'base64url').toString('utf8') : code
      return this.pairing().accept(JSON.parse(json), grants)
    })
  }

  /** Read staged outgoing attempts without their credentials.
   * @returns recoverable acceptance inventory.
   */
  @Remote
  pairingAttempts(): Promise<PairingAttemptMetadata[]> { return this.track(() => this.pairing().attempts()) }

  /** Discard an outgoing attempt after removing its configured connection.
   * @param id - selected outgoing attempt identity.
   */
  @Remote
  pairingForget(id: PairingInvitationId): Promise<void> { return this.track(() => this.pairing().forget(id)) }

  private pairing() {
    const pairing = this.ctx.get('environmentPairing')
    if (!pairing) throw new Error('Pairing service is unavailable')
    return pairing
  }

  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('environment management is closed'))
    const operation = run()
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
}
