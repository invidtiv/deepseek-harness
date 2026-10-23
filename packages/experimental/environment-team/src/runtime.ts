/** Single-coordinator teams with durable outboxes and receiver-owned Sessions. */
import { createHash, randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import { resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { TeamDashboardRequest, TeamDashboardResult } from './team-types.ts'
import type { ResolvedConfig } from './config.ts'
import { assignmentSchema, environmentIdSchema, teamSchema } from './protocol.ts'
import { EnvironmentWorkspaceBrowser } from './workspace-browser.ts'
import { EnvironmentSessions } from './session-service.ts'
import { EnvironmentSessionInteractions } from './session-interactions.ts'
import { terminalFrameStream, type TerminalFrameStream } from './terminal-stream.ts'
import type { EnvironmentTerminalFollowRequest } from './interaction-types.ts'
import { sessionFrameStream, type SessionFrameStream } from './session-stream.ts'
import type { EnvironmentSessionFollowRequest } from './session-types.ts'
import type { Assignment, Delivery, DistributedTeamId, EnvironmentDescriptor, EnvironmentId, Member, OperationId, PeerRequest, Team, TeamCommand } from './protocol.ts'
import { TerminalInputRoutes } from './terminal-input.ts'

const domainSpec = defineDomain({
  name: 'environment_teams', version: 1, layout: 'per-record',
  global: {
    schema: z.object({ environmentId: environmentIdSchema.nullable() }),
    initial: { environmentId: null as EnvironmentId | null },
  },
  tables: { teams: { valueSchema: teamSchema }, assignments: { valueSchema: assignmentSchema } },
})

/** Authenticated transport supplied by the HTTP adapter. */
export type PeerCall = (environment: EnvironmentId, request: PeerRequest, signal: AbortSignal) => Promise<string>

/** Runs distributed teams without substituting local execution for an unavailable peer. */
export class EnvironmentTeams {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly abort = new AbortController()
  private readonly terminalInputs = new TerminalInputRoutes()
  private readonly active = new Set<Promise<unknown>>()
  private pumping: Promise<void> | undefined
  private stopped = false
  private readonly workspaceSessions: EnvironmentSessions

  constructor(
    private readonly ctx: Context,
    readonly environmentId: EnvironmentId,
    private readonly config: ResolvedConfig,
    private readonly domain: Domain<typeof domainSpec>,
    private readonly call: PeerCall,
    private readonly receipts: ProjectionHandle<readonly MessageId[]>,
  ) {
    this.workspaceSessions = new EnvironmentSessions(ctx, environmentId, config)
  }

  /**
   * Open validated state before publishing tools or peer routes.
   * @param ctx - Context supplying durable storage and Agent services.
   * @param id - Persisted environment identity.
   * @param config - Resolved deployment configuration.
   * @param call - Identity-pinned peer transport.
   * @returns the initialized runtime, owned by the caller until close.
   */
  static async open(ctx: Context, id: EnvironmentId, config: ResolvedConfig, call: PeerCall): Promise<EnvironmentTeams> {
    const domain = await ctx.storageDomain.open(domainSpec)
    const bound = domain.global.get().environmentId
    if (bound !== null && bound !== id) {
      await domain.close()
      throw new Error('team storage belongs to a different environment')
    }
    try {
      if (bound === null) await domain.global.set({ environmentId: id })
    } catch (error) {
      await domain.close()
      throw error
    }
    for (const [, assignment] of domain.table('assignments').entries()) {
      if (assignment.member.environmentId !== id) {
        await domain.close()
        throw new Error('stored team assignments belong to a different environment')
      }
    }
    try {
      const receipts = await ctx.sessionProjections.register({
        key: 'environmentTeamReceipts', stateVersion: 1,
        stateSchema: z.array(z.string().transform(value => brandString<MessageId>(value))).readonly(),
        init: (): readonly MessageId[] => [],
        apply(state: readonly MessageId[], event) {
          if (event.type !== 'agent/inbox/spliced' || event.data.inserted.length === 0) return state
          const received = event.data.inserted.filter(message => message.id.startsWith('envteam:')).map(message => message.id)
          return received.length === 0 ? state : [...new Set([...state, ...received])]
        },
      })
      return new EnvironmentTeams(ctx, id, config, domain, call, receipts)
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /**
   * Describe this installation to connecting peers.
   * @returns public identity without credentials or filesystem paths.
   */
  descriptor(): EnvironmentDescriptor {
    return {
      environmentId: this.environmentId, label: this.config.label, platform: platform(),
      protocol: 1, capabilities: { distributedTeams: true, teamDashboard: true, workspaceBrowser: true, ...(this.ctx.get('sessionController') ? { workspaceSessions: true as const, workspaceSessionFollow: true as const, workspaceSessionInteractions: true as const, workspaceSessionHistory: true as const, workspaceSessionCatalogPaging: true as const } : {}) },
    }
  }

  /**
   * Execute a command for an exact live local Agent, forwarding to its coordinator when needed.
   * @param agent - Local caller authenticated by registry identity.
   * @param operation - Stable tool-call retry identity.
   * @param command - Validated operation.
   * @param signal - Caller cancellation before command admission.
   * @returns JSON text suitable for the logged tool result.
   */
  execute(agent: Agent, operation: OperationId, command: TeamCommand, signal: AbortSignal): Promise<string> {
    return this.track(async () => {
      if (this.ctx.agents.get(agent.id) !== agent) throw new Error('caller is not a live local Agent')
      signal.throwIfAborted()
      const assignment = await this.localMembership(agent)
      const request: PeerRequest = { kind: 'command', environmentId: assignment.coordinator, teamId: assignment.teamId, actor: agent.id, operationId: operation, command }
      return assignment.coordinator === this.environmentId
        ? this.command(this.environmentId, request)
        : this.call(assignment.coordinator, request, AbortSignal.any([signal, this.abort.signal]))
    })
  }

  /**
   * Dispatch one validated request after the carrier authenticates its peer identity.
   * @param peer - Environment established by the credential, never by request fields.
   * @param request - Parsed request whose target must match this runtime.
   * @param signal - Optional carrier cancellation for session reads and pre-admission checks.
   * @returns JSON text acknowledging only committed state or observed cancellation.
   */
  receive(peer: EnvironmentId, request: PeerRequest, signal: AbortSignal = this.abort.signal): Promise<string> {
    return this.track(async () => {
      if (request.environmentId !== this.environmentId) throw new Error('environment identity mismatch')
      switch (request.kind) {
        case 'session-interaction': return JSON.stringify(await new EnvironmentSessionInteractions(this.ctx, this.environmentId, this.config, this.terminalInputs).run(peer, request.request, AbortSignal.any([signal, this.abort.signal])))
        case 'team-dashboard': return JSON.stringify(await this.dashboard(peer, request.request, signal))
        case 'session': return JSON.stringify(await this.workspaceSessions.run(peer, request.request, AbortSignal.any([signal, this.abort.signal])))
        case 'workspace': return JSON.stringify(await new EnvironmentWorkspaceBrowser(this.ctx, this.environmentId, this.config).run(peer, request.request))
        case 'command': return this.command(peer, request)
        case 'deliver': return this.deliver(peer, request.assignment, request.message)
        case 'interrupt': {
          const assignment = this.domain.table('assignments').get(request.sessionId)
          if (!assignment || assignment.coordinator !== peer || assignment.teamId !== request.teamId) throw new Error('peer does not own this member')
          const agent = this.ctx.agents.get(SessionId(request.sessionId))
          agent?.cancel({ kind: 'parent' }, { keepInbox: true })
          return JSON.stringify({ status: agent ? 'interrupt-requested' : 'inactive' })
        }
        /* v8 ignore next -- The parsed PeerRequest union is exhaustively handled. */
        default: return assertNever(request)
      }
    })
  }

  /** Follow one authorized destination Session without retaining an unbounded writer queue.
   * @param peer - authenticated caller installation.
   * @param request - registered workspace and Session identities.
   * @param signal - HTTP client cancellation.
   * @returns replacement snapshots and the runtime-owned writer lifetime.
   */
  follow(peer: EnvironmentId, request: EnvironmentSessionFollowRequest, signal: AbortSignal): SessionFrameStream {
    const stream = sessionFrameStream(
      lifetime => this.workspaceSessions.follow(peer, request, lifetime), AbortSignal.any([signal, this.abort.signal]),
    )
    this.active.add(stream.done)
    void stream.done.then(() => this.active.delete(stream.done))
    return stream
  }

  /** Follow ordered terminal output without retaining unbounded viewer data.
   * @param peer - authenticated caller environment.
   * @param request - ordinary Session, terminal and exclusive input attachment.
   * @param signal - viewer cancellation.
   * @returns a bounded subscription whose teardown is owned by this runtime.
   */
  followTerminal(peer: EnvironmentId, request: EnvironmentTerminalFollowRequest, signal: AbortSignal): TerminalFrameStream {
    const stream = terminalFrameStream(
      lifetime => new EnvironmentSessionInteractions(this.ctx, this.environmentId, this.config, this.terminalInputs)
        .followTerminal(peer, request, lifetime),
      AbortSignal.any([signal, this.abort.signal]), this.config.maxBytes,
    )
    this.active.add(stream.done)
    void stream.done.then(() => this.active.delete(stream.done))
    return stream
  }

  /** Read coordinator records or interrupt a member using explicit operator grants.
   * @param peer - authenticated environment; this installation denotes its local operator.
   * @param request - requested dashboard operation.
   * @param signal - cancellation before admission and during remote interruption.
   * @returns bounded coordinator-owned data, without creating membership or Sessions.
   */
  dashboard(peer: EnvironmentId, request: TeamDashboardRequest, signal: AbortSignal): Promise<TeamDashboardResult> {
    return this.track(async () => {
      const lifetime = AbortSignal.any([signal, this.abort.signal])
      lifetime.throwIfAborted()
      const grant = this.config.peers.find(item => item.environmentId === peer)
      const local = peer === this.environmentId
      if (!local && !grant?.teamAccess) throw new Error('peer team access is not granted')
      const visible = (team: Team): boolean => {
        const lead = team.members.find(member => member.name === 'lead')
        return lead !== undefined && lead.environmentId === this.environmentId
          && (local || grant?.workspaces.includes(lead.workspace) === true)
      }
      let result: TeamDashboardResult
      if (request.action === 'catalog') {
        result = { kind: 'catalog', environmentId: this.environmentId,
          teams: [...this.domain.table('teams').entries()].map(([, team]) => team).filter(visible).flatMap(team => team.members.filter(member => member.name === 'lead').map(lead => ({
            teamId: team.id, workspace: lead.workspace, members: team.members.length,
            tasks: team.tasks.length, queuedMessages: team.pending.length,
          }))) }
      } else {
        const team = this.domain.table('teams').get(request.teamId)
        const lead = team?.members.find(member => member.name === 'lead')
        if (!team || !lead || !visible(team)) throw new Error('team is not available in granted workspaces')
        if (request.action === 'read') {
          result = { kind: 'team', environmentId: this.environmentId, teamId: team.id,
            workspace: lead.workspace,
            members: structuredClone(team.members), tasks: structuredClone(team.tasks),
            outbox: team.pending.map(({ id, sender, target }) => ({ id, sender, target })) }
        } else {
          if (!local && !grant?.teamOperate) throw new Error('peer team operation is not granted')
          const member = team.members.find(item => item.sessionId === request.sessionId && item.name !== 'lead')
          if (!member) throw new Error('interrupt target must be a non-lead team member')
          const outgoing: PeerRequest = { kind: 'interrupt', environmentId: member.environmentId,
            teamId: team.id, sessionId: member.sessionId }
          const text = member.environmentId === this.environmentId
            ? await this.receive(this.environmentId, outgoing, lifetime)
            : await this.call(member.environmentId, outgoing, lifetime)
          const status = z.object({ status: z.enum(['interrupt-requested', 'inactive']) }).strict().parse(JSON.parse(text)).status
          result = { kind: 'interrupted', environmentId: this.environmentId, teamId: team.id,
            sessionId: member.sessionId, status }
        }
      }
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxBytes) throw new Error('team dashboard byte limit reached')
      return result
    })
  }

  /**
   * Attempt pending deliveries in order, stopping each target after its first failure.
   * @returns completion of one retry pass, shared by concurrent triggers.
   */
  pump(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.pumping ??= this.track(async () => {
      for (const [id, team] of this.domain.table('teams').entries()) {
        const blockedTargets = new Set<string>()
        for (const message of team.pending) {
          if (this.stopped) return
          if (blockedTargets.has(message.target)) continue
          const member = team.members.find(item => item.name === message.target)
          if (!member) throw new Error('pending message has no roster target')
          const assignment: Assignment = { coordinator: this.environmentId, teamId: team.id, member }
          try {
            if (member.environmentId === this.environmentId) await this.deliver(this.environmentId, assignment, message)
            else await this.call(member.environmentId, { kind: 'deliver', environmentId: member.environmentId, assignment, message }, this.abort.signal)
            await this.serial(`team:${id}`, () => this.domain.table('teams').update(id, current => ({ ...current, pending: current.pending.filter(item => item.id !== message.id) })))
          } catch (error) {
            // Transport or persistence failure leaves the durable outbox authoritative.
            if (this.abort.signal.aborted) return
            blockedTargets.add(message.target)
            this.ctx.logger.warn(`distributed team delivery ${message.id} remains queued (${error instanceof Error ? error.name : 'failure'})`)
          }
        }
      }
    }).finally(() => { this.pumping = undefined })
    return this.pumping
  }

  /**
   * Stop admission and cancel owned work before releasing storage.
   * @returns completion after transport, owned Agents, and storage reach quiescence.
   */
  async close(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    await Promise.allSettled([...this.active])
    try {
      const disposed = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
      const errors = disposed.filter(item => item.status === 'rejected').map((item): unknown => item.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'distributed members failed to dispose')
    } finally {
      this.handles.clear()
      try { await this.domain.close() } finally { await this.receipts.dispose() }
    }
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('environment teams are stopping'))
    const pending = operation()
    this.active.add(pending)
    void pending.then(() => this.active.delete(pending), () => this.active.delete(pending))
    return pending
  }

  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve()
    const run = prior.then(operation)
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    try { return await run } finally { if (this.queues.get(key) === tail) this.queues.delete(key) }
  }

  private async localMembership(agent: Agent): Promise<Assignment> {
    return this.serial('membership', async () => {
      const existing = this.domain.table('assignments').get(agent.id)
      if (existing) return existing
      const cwd = agent.session.header.cwd
      const workspace = Object.entries(this.config.workspaces).find(([, path]) => cwd !== undefined && resolve(path) === resolve(cwd))?.[0]
      if (!workspace) throw new Error('Session cwd must match a configured environment workspace')
      const teamId = brandString<DistributedTeamId>(agent.id)
      const member: Member = { environmentId: this.environmentId, sessionId: agent.id, name: 'lead', workspace }
      const assignment: Assignment = { coordinator: this.environmentId, teamId, member }
      if (!this.domain.table('teams').get(teamId)) {
        if (this.domain.table('teams').size >= this.config.maxTeams) throw new Error('distributed team limit reached')
        await this.domain.table('teams').put(teamId, { id: teamId, members: [member], tasks: [], pending: [], receipts: [] })
      }
      await this.domain.table('assignments').put(agent.id, assignment)
      return assignment
    })
  }

  private async command(peer: EnvironmentId, request: Extract<PeerRequest, { kind: 'command' }>): Promise<string> {
    return this.serial(`team:${request.teamId}`, async () => {
      const team = this.domain.table('teams').get(request.teamId)
      if (!team) throw new Error('distributed team not found')
      const actor = team.members.find(item => item.environmentId === peer && item.sessionId === request.actor)
      if (!actor) throw new Error('caller is not a member of this team')
      if (request.command.action === 'list') return this.view(team)
      if (request.command.action === 'interrupt') return this.interrupt(peer, request.teamId, request.actor, request.command.target)
      const fingerprint = createHash('sha256').update(JSON.stringify(request.command)).digest('hex')
      const receipt = team.receipts.find(item =>
        item.id === request.operationId && item.actor === actor.sessionId && item.environmentId === peer)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error('operation identity was reused with different arguments')
        return receipt.result
      }
      if (team.receipts.length >= this.config.maxOperations) throw new Error('team operation retention limit reached; create a new team')
      const commandId = brandString<OperationId>(createHash('sha256').update(JSON.stringify([peer, actor.sessionId, request.operationId])).digest('hex'))
      let next: Team = structuredClone(team)
      let result: string
      switch (request.command.action) {
        case 'spawn': {
          const command = request.command
          if (actor.name !== 'lead') throw new Error('only the lead may spawn members')
          if (next.members.length >= this.config.maxMembers) throw new Error('team member limit reached')
          if (next.members.some(item => item.name === command.name)) throw new Error('member name already exists')
          if (command.environmentId === this.environmentId) {
            if (!this.config.workspaces[command.workspace]) throw new Error('workspace alias is not configured')
          } else if (!this.config.peers.some(item => item.environmentId === command.environmentId && item.workspaces.includes(command.workspace))) throw new Error('peer workspace is not granted')
          const member: Member = {
            environmentId: command.environmentId, sessionId: SessionId(randomUUID()),
            name: command.name, workspace: command.workspace,
          }
          next.members.push(member)
          next.pending.push({ id: commandId, sender: actor.name, target: member.name, text: command.text })
          result = JSON.stringify({ member, delivery: 'queued' })
          break
        }
        case 'send': {
          const command = request.command
          if (!next.members.some(item => item.name === command.target)) throw new Error('target member not found')
          next.pending.push({ id: commandId, sender: actor.name, target: command.target, text: command.text })
          result = JSON.stringify({ messageId: commandId, delivery: 'queued' })
          break
        }
        case 'task-create': {
          if (next.tasks.length >= this.config.maxTasks) throw new Error('team task limit reached')
          const task = { id: commandId, text: request.command.text, revision: 1, status: 'pending' as const }
          next.tasks.push(task)
          result = JSON.stringify(task)
          break
        }
        case 'task-update': {
          const command = request.command
          const task = next.tasks.find(item => item.id === command.taskId)
          if (!task) throw new Error('task not found')
          if (task.revision !== command.revision) throw new Error('stale task revision; list tasks before retrying')
          if (task.owner && task.owner !== actor.name && actor.name !== 'lead') throw new Error('task is owned by another member')
          if (command.status === 'completed' && task.status !== 'in_progress') throw new Error('claim the task before completing it')
          task.status = command.status
          task.revision++
          if (command.status === 'pending') delete task.owner
          else task.owner ??= actor.name
          result = JSON.stringify(task)
          break
        }
        /* v8 ignore next -- The parsed command union is exhaustively handled. */
        default: return assertNever(request.command)
      }
      next = {
        ...next,
        receipts: [...next.receipts, { id: request.operationId, actor: actor.sessionId, environmentId: peer, fingerprint, result }],
      }
      if (Buffer.byteLength(JSON.stringify(next)) > this.config.maxBytes) throw new Error('team state byte limit reached')
      await this.domain.table('teams').put(team.id, next)
      return result
    })
  }

  private view(team: Team): string {
    return JSON.stringify({
      teamId: team.id, coordinator: this.environmentId,
      members: team.members, tasks: team.tasks, queuedMessages: team.pending.length,
    })
  }

  private async interrupt(peer: EnvironmentId, teamId: DistributedTeamId, actor: SessionId, target: string): Promise<string> {
    const team = this.domain.table('teams').get(teamId)
    const lead = team?.members[0]
    if (!team || !lead || lead.environmentId !== peer || lead.sessionId !== actor) throw new Error('only the lead may interrupt members')
    const member = team.members.find(item => item.name === target && item.name !== 'lead')
    if (!member) throw new Error('teammate not found')
    const outgoing: PeerRequest = { kind: 'interrupt', environmentId: member.environmentId, teamId: team.id, sessionId: member.sessionId }
    return member.environmentId === this.environmentId
      ? this.receive(this.environmentId, outgoing)
      : this.call(member.environmentId, outgoing, this.abort.signal)
  }

  private async deliver(peer: EnvironmentId, assignment: Assignment, message: Delivery): Promise<string> {
    if (assignment.coordinator !== peer || assignment.member.environmentId !== this.environmentId || message.target !== assignment.member.name) throw new Error('delivery ownership mismatch')
    const member = assignment.member
    if (peer !== this.environmentId && !this.config.peers.some(item => item.environmentId === peer && item.workspaces.includes(member.workspace))) throw new Error('peer workspace is not granted')
    const cwd = this.config.workspaces[member.workspace]
    if (!cwd) throw new Error('workspace alias is not configured')
    const text = `[Distributed team ${assignment.teamId}; coordinator ${peer}; you are ${member.name}; sender ${message.sender}]\n${message.text}\nUse environment_team to list the team, send messages, and update shared tasks.`
    if (Buffer.byteLength(text) > this.config.maxBytes) throw new Error('message byte limit reached')
    return this.serial(`delivery:${member.sessionId}`, async () => {
      const assignments = this.domain.table('assignments')
      await this.serial('membership', async () => {
        const existing = assignments.get(member.sessionId)
        if (existing && JSON.stringify(existing) !== JSON.stringify(assignment)) throw new Error('Session assignment conflict')
        if (!existing) {
          if (this.ctx.agents.get(SessionId(member.sessionId)) || await this.ctx.sessionPersistence.stat(SessionId(member.sessionId))) throw new Error('Session identity already exists outside this assignment')
          if (assignments.size >= this.config.maxTeams * this.config.maxMembers) throw new Error('local member limit reached')
          await assignments.put(member.sessionId, assignment)
        }
      })
      let agent = this.ctx.agents.get(SessionId(member.sessionId))
      if (!agent) {
        const stored = await this.ctx.sessionPersistence.stat(SessionId(member.sessionId))
        if (stored && stored.header.cwd !== cwd) throw new Error('stored member workspace differs from the configured directory')
        const setup = async (agentCtx: Context, memberAgent: Agent): Promise<void> => {
          const preset = this.ctx.agentPresets.presetForSession(memberAgent.session)
          if (preset === null) throw new Error('stored member lacks its agent preset')
          await this.ctx.agentPresets.mount(agentCtx, preset)
          if (!stored) {
            setSandboxMode(memberAgent.session, this.config.sandboxMode)
            setApprovalPolicy(memberAgent.session, this.config.approvalPolicy)
          }
        }
        const agentOptions = { provider: this.config.provider, model: this.config.model }
        const handle = stored
          ? await this.ctx.agents.resume({ resumeSessionId: SessionId(member.sessionId), agentOptions, setup, signal: this.abort.signal })
          : await this.ctx.agents.create({
            sessionId: member.sessionId, meta: { cwd, agentPreset: this.config.agentPreset },
            agentOptions, setup, signal: this.abort.signal,
          })
        this.handles.set(member.sessionId, handle)
        agent = handle.agent
      }
      if (agent.session.header.cwd !== cwd) throw new Error('live member workspace differs from the configured directory')
      await (await this.ctx.workspaceRegistry.create(cwd)).attachSession(agent.id)
      const id = brandString<MessageId>(`envteam:${createHash('sha256').update(JSON.stringify([assignment.coordinator, assignment.teamId, message.sender, message.id])).digest('hex')}`)
      const accepted = this.receipts.stateOf(agent.session)
      if (!accepted.includes(id)) {
        const input: UserMessage = {
          id, role: 'user',
          source: { kind: 'environment-team', coordinator: peer, teamId: assignment.teamId, sender: message.sender },
          content: [{ type: 'text', text }],
        }
        agent.steer(input)
      }
      await this.ctx.sessions.flush(agent.session)
      if (!this.receipts.stateOf(agent.session).includes(id)) throw new Error('message acceptance was not recorded')
      return JSON.stringify({ delivery: 'accepted' })
    })
  }
}
