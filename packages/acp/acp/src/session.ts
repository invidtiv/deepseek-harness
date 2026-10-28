/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */

import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import {
  RequestError,
  type AvailableCommand,
  type McpServer,
  type PlanEntry,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentOptions, AgentStatus } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionLogOffset, type Session, type SessionEvent, type SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { AcpContentError, admitAcpPrompt } from './content.ts'
import { turnEndToStopReason } from './codec.ts'
import { mountAcpMcpServers } from './mcp.ts'
import { AcpJobOutput } from './job-output.ts'
import { AcpModelControl, AcpModelConfigError } from './model-control.ts'
import type { AcpOutput, ForegroundState, IdleReason } from './output.ts'
import { planEntries } from './updates.ts'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'

/** Subagent completion and teardown without depending on the subagent package. */
interface SubagentLifecycle {
  /** Dispose subagent descendants below exact host-owned parents child-first. */
  drainDescendants(parents: readonly Agent[]): Promise<void>
  /** Observe currently managed descendants without closing future admission. */
  waitForChildren(parent: Agent): Promise<boolean>
}

/** Inputs shared by fresh and resumed ACP session construction. */
interface AcpSessionBuildOptions {
  cwd: string
  /** Whether this connection negotiated human form elicitation. */
  formElicitation: boolean
  mcpServers: readonly McpServer[]
  agentOptions: AgentOptions
  signal: AbortSignal
  /** Negotiated-protocol delivery for the constructed session's updates. */
  output: (sessionId: SessionId) => AcpOutput
}

/** Fresh ACP session construction inputs. */
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** Persisted ACP session construction inputs. */
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** Fork construction receives a fixed, committed source prefix; no live resources are shared. */
export interface ForkAcpSessionOptions extends CreateAcpSessionOptions {
  sourceEvents: readonly SessionEvent[]
}

interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  /** The message's `user/message` event has committed to the conversation. */
  committed: boolean
  /** Commit observer; request cancellation stops owning the message once it runs. */
  accept: ((message: UserMessage) => void) | undefined
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  completionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancellationDone: PromiseWithResolvers<void>
  cancelStartedIdle: boolean
  settlementStarted: boolean
  outputError: Error | undefined
  agentError: Error | undefined
}

/** Standard invalid-parameter failure with protocol-safe detail. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Standard internal failure with protocol-safe detail. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Install switch notices and mount the requested MCP clients in the unpublished Agent scope.
 * @param agentCtx - unpublished Agent scope.
 * @param options - workspace and MCP servers requested for the session.
 */
async function composeAgent(agentCtx: Context, options: AcpSessionBuildOptions): Promise<void> {
  installModelSelection(agentCtx)
  const tools = agentCtx.get('tools')
  if (options.formElicitation && tools !== undefined && agentCtx.get('userQuestions') !== undefined
    && tools.get('ask_user_question', scopeOf(agentCtx)) === undefined) {
    await agentCtx.plugin(ToolAskUser)
  }
  await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
}

/** A command stopped by `session/cancel`, request cancellation, or session close before it settled. */
class AcpCommandCancelled extends Error {
  constructor() { super('ACP command cancelled') }
}

/** Terminal foreground state with optional failure detail. */
function idleState(stopReason: IdleReason, error?: string): ForegroundState {
  return { state: 'idle', stopReason, ...error === undefined ? {} : { error } }
}

/** Terminal state of autonomous activity, from the last turn it ended. */
function autonomousIdle(cancelled: boolean, ending: TurnEndReason | undefined): ForegroundState {
  if (cancelled) return idleState('cancelled')
  /* v8 ignore next -- AgentLoop commits turn/end for every running interval, including a wake whose message was removed. */
  if (ending === undefined) return idleState('cancelled')
  return ending.kind === 'error' ? idleState('error', ending.error.message) : idleState(turnEndToStopReason(ending))
}

/**
 * Per-session ACP module. It owns the unpublished Agent composition, selected
 * route, one-prompt admission slot, ordered protocol updates, and memoized
 * quiescent teardown.
 */
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent
  private readonly modelControl: AcpModelControl
  private readonly output: AcpOutput
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private autonomousEnding: TurnEndReason | undefined
  private autonomousCancelled = false
  private pendingPermissions = 0
  private closing: Promise<void> | undefined
  private command: { controller: AbortController; done: Promise<void> } | undefined
  private goalText: string | undefined
  private planVisible = false
  private jobOutput: AcpJobOutput | undefined

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    output: AcpSessionBuildOptions['output'],
  ) {
    this.agent = handle.agent
    this.modelControl = new AcpModelControl(ctx.llm, handle.agent.model)
    this.output = output(handle.agent.session.id)
    this.disposeAgent = () => handle.dispose()
    handle.agent.ctx.inject(['jobs'], (jobCtx) => {
      const observer = new AcpJobOutput(jobCtx.jobs, this.agent.session.id,
        (deliver) => { this.enqueue(deliver) }, (callId, text) => this.output.toolOutput(callId, text))
      this.jobOutput = observer
      jobCtx.effect(() => () => {
        observer.dispose()
        if (this.jobOutput === observer) this.jobOutput = undefined
      }, 'acp.job-output')
    })
  }

  private readonly disposeAgent: () => Promise<void>

  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - fresh session identity, workspace, route, MCP, and output.
   * @returns the fully composed per-session module.
   */
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: agentCtx => composeAgent(agentCtx, options),
    })
    return new AcpSession(ctx, handle, options.output)
  }

  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * The Session's recorded model selection survives; deployment options supply
   * the route only when the Session records neither a selection nor a request.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - persisted identity, workspace, fallback route, MCP, and output.
   * @returns the restored per-session module.
   */
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: agentCtx => composeAgent(agentCtx, options),
    })
    return new AcpSession(ctx, handle, options.output)
  }

  /**
   * Publish an independent Agent seeded from committed source events.
   * @param ctx - ACP context owning the new Agent lifecycle.
   * @param options - new identity, fresh MCP connections, and fixed source history.
   * @returns the independently owned fork session.
   */
  static async fork(ctx: Context, options: ForkAcpSessionOptions): Promise<AcpSession> {
    const boundary = options.sourceEvents.at(-1)?.seq
    const seed = boundary === undefined ? [] : buildForkSeed(options.sourceEvents, boundary)
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      seed,
      inheritedEventCount: SessionLogOffset(options.sourceEvents.length),
      meta: { cwd: options.cwd, isSeeded: true },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: agentCtx => composeAgent(agentCtx, options),
    })
    return new AcpSession(ctx, handle, options.output)
  }

  /** Reject forks while this session has foreground or autonomous work in flight. */
  assertForkable(): void {
    this.assertActive()
    if (this.inflight !== undefined || this.command !== undefined || this.agent.status !== 'idle'
      || this.pendingPermissions > 0 || this.ctx.agents.turnBoundaryOf(this.agent.session).openTurnStartSeq !== null) {
      throw invalidParams('cannot fork a session with work in flight')
    }
  }

  /**
   * Whether this module owns an exact Agent reference.
   * @param agent - Agent observed on a scoped runtime event.
   * @returns true only for this session's owned Agent.
   */
  owns(agent: Agent): boolean {
    return this.agent === agent
  }

  /**
   * Whether this module owns an exact Session reference.
   * @param session - Session observed on a durable event.
   * @returns true only for this session's owned Session.
   */
  ownsSession(session: Session): boolean {
    return this.agent.session === session
  }

  /**
   * Return the model configuration and composed collaboration controls.
   * @param signal - optional request cancellation.
   * @returns provider-grouped models, reasoning, and available collaboration modes.
   */
  async configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    const options = await this.modelControl.options(signal)
    const planMode = this.agent.ctx.get('planMode')
    if (planMode !== undefined) {
      const state = planMode.get(this.agent)
      options.push({
        id: 'collaboration_mode', name: 'Collaboration mode', category: 'mode', type: 'select',
        currentValue: (state.pending ?? state.active) ? 'plan' : 'build',
        options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }],
      })
    }
    return options
  }

  /**
   * Apply one standard configuration option from the next model step.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional request cancellation.
   * @returns the complete resulting option state.
   */
  async setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    if (configId === 'collaboration_mode') {
      const planMode = this.agent.ctx.get('planMode')
      if (planMode === undefined) throw new AcpModelConfigError('plan mode is unavailable in this deployment')
      if (value !== 'plan' && value !== 'build') throw new AcpModelConfigError('collaboration_mode requires plan or build')
      signal?.throwIfAborted()
      planMode.set(this.agent, value === 'plan')
    } else {
      await this.modelControl.set(configId, value, signal)
    }
    return this.configOptions(signal)
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged(): void {
    if (this.closing !== undefined) return
    void this.configOptions()
      .then((configOptions) => {
        if (this.closing === undefined) this.enqueue(() => this.output.configOptions(configOptions))
      })
      /* v8 ignore start -- option discovery contains per-provider failure. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * Read commands registered for this exact Agent; no registry means no commands.
   * @returns standard command descriptors without Harness presentation metadata.
   */
  availableCommands(): AvailableCommand[] {
    return (this.ctx.get('commands')?.list(this.agent) ?? []).map(({ name, description, input }) => ({
      name, description,
      ...input === undefined ? {} : { input: { hint: input.hint } },
    }))
  }

  /** Publish a complete replacement command list after registry changes. */
  commandsChanged(): void {
    if (this.closing !== undefined) return
    const commands = this.availableCommands()
    this.enqueue(() => this.output.commands(commands))
  }

  /**
   * Publish autonomous activity outside a foreground prompt, including goal rounds.
   * @param status - current Agent status after a lifecycle transition.
   */
  onStatus(status: Agent['status']): void {
    if (this.closing !== undefined) return
    if (status === 'running') {
      this.autonomousEnding = undefined
      this.autonomousCancelled = false
    }
    if (this.inflight !== undefined) return
    if (status === 'running') this.enqueue(() => this.output.state({ state: 'running' }))
    if (status === 'idle') {
      const idle = autonomousIdle(this.autonomousCancelled, this.autonomousEnding)
      this.enqueue(() => this.output.state(idle))
    }
  }

  /** Execute recognized text commands independently of the foreground model prompt. */
  private runCommand(params: PromptRequest, requestSignal: AbortSignal): Promise<MessageId> | undefined {
    this.assertActive()
    const registry = this.ctx.get('commands')
    const line = params.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const parsed = parseCommand(line)
    if (registry === undefined || parsed === undefined || registry.find(this.agent, parsed.name) === undefined) return undefined
    if (params.prompt.some(block => block.type !== 'text')) throw invalidParams('ACP commands accept text only')
    if (this.command !== undefined) throw invalidParams('a command is already in flight for this session')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, requestSignal])
    const completion = Promise.withResolvers<void>()
    this.command = { controller, done: completion.promise }
    const { id: messageId } = createUserMessage({ content: [{ type: 'text', text: line }], source: { kind: 'user' } })
    return (async () => {
      try {
        let execution: Awaited<ReturnType<typeof registry.execute>>
        try {
          execution = await registry.execute(this.agent, line, [], signal)
        } catch (error: unknown) {
          // The registry settles an aborted handler as a failure; the bridge reports it as cancellation.
          if (signal.aborted) throw new AcpCommandCancelled()
          throw error
        }
        if (execution === undefined) throw invalidParams(`command is no longer available: /${parsed.name}`)
        await this.ctx.sessions.flush(this.agent.session)
        const text = execution.result.text ?? ''
        this.enqueue(async () => {
          await this.output.commandResult(messageId, line, text)
          // A command that started no foreground work completes with its result.
          if (this.inflight === undefined && this.agent.status === 'idle') await this.output.state(idleState('end_turn'))
        })
        await this.outputTail
        return messageId
      } finally {
        this.command = undefined
        completion.resolve()
      }
    })()
  }

  /**
   * Admit, enqueue, and settle one prompt at whole-Agent quiescence.
   * @param params - standard ACP prompt request for this session.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation signal.
   * @param accepted - optional observer of the message's commit to the conversation;
   *   request cancellation stops owning the message at that commit.
   * @returns the correlated standard stop reason after ordered updates drain.
   */
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal: AbortSignal,
    accepted?: (message: UserMessage) => void,
  ): Promise<PromptResponse> {
    this.assertActive()
    const command = this.runCommand(params, requestSignal)
    if (command !== undefined) {
      try {
        await command
      } catch (error: unknown) {
        if (error instanceof AcpCommandCancelled) return { stopReason: 'cancelled' }
        throw error
      }
      return { stopReason: 'end_turn' }
    }
    if (this.command !== undefined) throw invalidParams('a command is already in flight for this session')
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    const completion = Promise.withResolvers<StopReason>()
    const admission = Promise.withResolvers<void>()
    const admissionController = new AbortController()
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      committed: false,
      accept: accepted === undefined ? undefined : (message) => {
        requestSignal.removeEventListener('abort', onRequestAbort)
        accepted(message)
      },
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      completionDone: completion.promise.then(() => {}, () => {}),
      finishAdmission: admission.resolve,
      admissionController,
      cancellationDone: Promise.withResolvers<void>(),
      cancelStartedIdle: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    this.inflight = inflight
    requestSignal.addEventListener('abort', onRequestAbort, { once: true })
    /* v8 ignore next -- the SDK dispatches a live signal, then notifies abort through its listener. */
    if (requestSignal.aborted) onRequestAbort()
    try {
      let admissionFailure: unknown
      const promptSelection = this.agent.model.current()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        inflight.messageId = message.id
        inflight.messageQueued = true
        try {
          this.agent.followup(message)
        } catch (error: unknown) {
          inflight.messageQueued = false
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.admissionController.signal.aborted) {
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal.removeEventListener('abort', onRequestAbort)
    }
  }

  /**
   * Resolve with the message identity once the prompt commits to the conversation;
   * completion travels through foreground states.
   * @param params - admitted prompt fields.
   * @param imageEnabled - negotiated image capability.
   * @param signal - request cancellation, effective until the commit.
   * @returns the committed message ID, or a live-only command ID after execution.
   */
  promptAccepted(params: PromptRequest, imageEnabled: boolean, signal: AbortSignal): Promise<string> {
    const command = this.runCommand(params, signal)
    if (command !== undefined) {
      return command.catch((error: unknown) => {
        // A cancelled command echoed nothing, so the request fails like a prompt cancelled before insertion.
        throw error instanceof AcpCommandCancelled ? invalidParams('command cancelled before completion') : error
      })
    }
    const acceptance = Promise.withResolvers<string>()
    let committed = false
    void this.prompt(params, imageEnabled, signal, (message) => {
      committed = true
      acceptance.resolve(message.id)
    }).then(
      () => { if (!committed) acceptance.reject(invalidParams('prompt cancelled before insertion')) },
      (error: unknown) => { if (!committed) acceptance.reject(error) },
    )
    return acceptance.promise
  }

  /**
   * Bracket foreground and autonomous permission exchanges with activity states.
   * @param answer - transport exchange; policy remains with the approval service.
   * @returns the client's answer after earlier updates and the corresponding state transition.
   */
  async withPermission<T>(answer: () => Promise<T>): Promise<T> {
    const owner = this.inflight
    this.pendingPermissions++
    if (owner?.admissionController.signal.aborted !== true && !this.autonomousCancelled) {
      this.enqueue(() => this.output.state({ state: 'requires_action' }))
    }
    await this.outputTail
    try {
      return await answer()
    } finally {
      this.pendingPermissions--
      if (this.inflight === owner && owner?.admissionController.signal.aborted !== true && !this.autonomousCancelled
        && this.pendingPermissions === 0 && this.closing === undefined) {
        this.enqueue(() => this.output.state({ state: 'running' }))
        await this.outputTail
      }
    }
  }

  /**
   * Replay retained conversation facts ahead of every later live update,
   * including every standing-plan replacement.
   * @param open - opens a persisted reader whose events cover `end`; the replay closes it.
   * @param end - first sequence number delivered live rather than replayed.
   * @param pageSize - maximum events fetched per storage read.
   * @param signal - activation request cancellation.
   * @returns completion after all retained updates have been delivered.
   */
  replay(open: () => Promise<SessionHandle>, end: number, pageSize: number, signal: AbortSignal): Promise<void> {
    const session = this.agent.session
    const replay = this.outputTail.then(async () => {
      const reader = await open()
      try {
        for (let offset = 0; offset < end;) {
          signal.throwIfAborted()
          const { events } = await reader.read(offset, Math.min(pageSize, end - offset), { signal })
          if (events.length === 0) throw internalError('session replay is missing persisted events')
          for (const event of events) {
            signal.throwIfAborted()
            await this.deliver(session, event, true)
          }
          offset += events.length
        }
      } finally {
        await reader.close()
      }
    })
    // The activation that requested this replay observes its failure and closes the session.
    this.outputTail = replay.catch((_failureOwnedByActivation: unknown) => {})
    return replay
  }

  /**
   * Restore the current goal and, unless history replay already delivered it, the standing plan.
   * @param options - `plan` publishes the projected todo list.
   * @returns completion of the ordered state updates.
   */
  async restoreProgress(options: { plan: boolean }): Promise<void> {
    this.goalChanged()
    if (options.plan) {
      /* v8 ignore next -- the shipped profiles and the test harness mount the projection registry. */
      const todos = this.ctx.get('sessionProjections')?.snapshot(this.agent.session, ['todos']).values.todos
      if (todos != null) {
        const entries = planEntries(todos)
        this.enqueue(() => this.sendPlan(entries))
      }
    }
    await this.outputTail
  }

  /**
   * Report the idle foreground state of a session that has just been restored.
   * @returns completion once the state has been delivered behind restored progress.
   */
  async announceIdle(): Promise<void> {
    this.enqueue(() => this.output.state({ state: 'idle' }))
    await this.outputTail
  }

  /** Publish the current goal, including process-local activation and admitted rounds. */
  goalChanged(): void {
    const goals = this.ctx.get('goals')
    if (goals === undefined) return
    const goal = goals.get(this.agent)
    if (goal === undefined && this.goalText === undefined) return
    const text = goal === undefined ? 'Goal cleared.' : formatGoal(goal)
    if (text === this.goalText) return
    this.goalText = text
    // A command's own result already reports the mutation it made; status text covers
    // autonomous changes and restoration only.
    if (this.command !== undefined) return
    const messageId = `goal:${this.agent.session.id}:${this.agent.session.seq}:${goal?.activation ?? 'cleared'}`
    this.enqueue(() => this.output.status(messageId, text))
  }

  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel(): void {
    const inflight = this.inflight
    this.command?.controller.abort(new Error('ACP command cancelled'))
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) {
      this.autonomousCancelled = true
      this.agent.cancel({ kind: 'user' })
    }
  }

  /**
   * Process one durable event and enqueue its standard ACP projections.
   * @param session - exact event-owning Session.
   * @param event - committed durable event.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'plan/mode') this.topologyChanged()
    if (event.type === 'job/registered') this.jobOutput?.register(event.data)
    if (event.type === 'tool/result') this.jobOutput?.complete(event.data.message.toolCallId)
    if (event.type === 'turn/start' && this.inflight?.turn !== undefined) {
      this.inflight.turn = event.data.turn
      this.inflight.endReason = undefined
    }
    const inflight = this.inflight
    if (inflight !== undefined && !inflight.committed && event.type === 'user/message' && event.data.id === inflight.messageId) {
      // The submitting client already owns this message; replay still includes its committed text.
      inflight.committed = true
      this.enqueue(() => this.output.state({ state: 'running' }))
      inflight.accept?.(event.data)
    } else {
      this.enqueue(() => this.deliver(session, event, false))
    }
    if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
      inflight.endReason = event.data.reason
      inflight.agentError = undefined
    }
    if (event.type === 'turn/end') {
      this.autonomousEnding = event.data.reason
    }
  }

  /**
   * Correlate an accepted user message with its Agent turn.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
  }

  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param error - original same-process failure.
   */
  onAgentError(error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // A later committed turn/end supersedes this live failure. Failed turn
    // start/end appends have no terminal record and keep the failure observable.
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
  }

  /**
   * Complete cancelled activity without following a later root driver.
   * @param status - the emitted transition, which may precede a reentrant wake.
   */
  onAgentStatus(status: AgentStatus): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued || !inflight.admissionController.signal.aborted) return
    // Maintenance remains publicly idle; its next running transition belongs
    // to work released after the maintenance task finished.
    if (status === 'idle' || inflight.cancelStartedIdle) inflight.cancellationDone.resolve(this.outputTail)
  }

  /** Await every update queued before this call. */
  drainUpdates(): Promise<void> {
    return this.outputTail
  }

  /**
   * Cancel, drain, flush, and dispose this session once.
   * @param detail - cancellation detail for any prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.jobOutput?.dispose()
    this.closing = (async () => {
      const failures: unknown[] = []
      const inflight = this.inflight
      this.command?.controller.abort(new Error(detail))
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        await this.command?.done
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
        await inflight?.completionDone
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
      try {
        await subagents?.drainDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('subagent teardown failed', { cause: error }))
      }
      try {
        await this.ctx.sessions.flush(this.agent.session)
      } catch (error: unknown) {
        failures.push(new Error('ACP session persistence flush failed', { cause: error }))
      }
      try {
        await this.disposeAgent()
      } catch (error: unknown) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      /* v8 ignore start -- independent teardown failures can aggregate only under multiple simultaneous provider faults. */
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`)
      }
      /* v8 ignore stop */
    })()
    return this.closing
  }

  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  /** Deliver one live or replayed event, preceded by any standing-plan change it makes. */
  private async deliver(session: Session, event: SessionEvent, replay: boolean): Promise<void> {
    if (event.type === 'todo/write') await this.sendPlan(planEntries(event.data.todos))
    // Each turn starts without a plan, so a visible one is cleared rather than carried over.
    else if (event.type === 'turn/start' && this.planVisible) await this.sendPlan([])
    await this.output.event(session, event, replay)
  }

  /** Replace the client's plan in delivery order, so replay and live updates share one plan state. */
  private sendPlan(entries: readonly PlanEntry[]): Promise<void> {
    this.planVisible = entries.length > 0
    return this.output.plan(entries)
  }

  /**
   * Append one delivery to the ordered output chain. A projection failure is
   * logged and fails the foreground prompt current at enqueue time.
   */
  private enqueue(deliver: () => Promise<void>): void {
    const inflight = this.inflight
    this.outputTail = this.outputTail.then(deliver).catch((error: unknown) => {
      if (inflight !== undefined) inflight.outputError ??= new Error(errorChain(error))
      this.ctx.logger.warn(`acp: output conversion failed: ${errorChain(error)}`)
    })
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    const firstCancellation = !inflight.admissionController.signal.aborted
    if (firstCancellation) inflight.cancelStartedIdle = this.agent.status === 'idle'
    inflight.admissionController.abort(new Error(detail))
    this.settleAfterQuiescence(inflight)
    if (!inflight.messageQueued) {
      inflight.cancellationDone.resolve()
      return
    }
    this.agent.cancel({ kind: 'user' })
    if (firstCancellation) {
      const done = inflight.cancellationDone
      // Plugin disposal can detach status observers before this activity retires.
      void this.agent.whenIdle().then(() => { done.resolve(this.outputTail) }, done.reject)
    }
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
        const cancelled = inflight.cancellationDone.promise
        const isCancelled = (): boolean => inflight.admissionController.signal.aborted
        const idleAt = (seq: Session['seq']): boolean => this.agent.status === 'idle' && this.agent.session.seq === seq
        while (true) {
          await Promise.race([this.agent.whenIdle(), cancelled])
          if (isCancelled()) break
          const idleSeq = this.agent.session.seq
          const children = await Promise.race([subagents?.waitForChildren(this.agent), cancelled])
          if (isCancelled()) break
          if (children || !idleAt(idleSeq)) continue
          await this.outputTail
          if (isCancelled() || idleAt(idleSeq)) break
        }
        if (isCancelled()) await cancelled
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (this.inflight !== inflight) return
      const outcome = settlementOf(inflight)
      // Only a committed prompt reported running; an uncommitted one fails its acceptance instead.
      if (inflight.committed) {
        const idle = outcome.kind === 'stopped' ? idleState(outcome.stopReason) : idleState('error', outcome.message)
        this.enqueue(() => this.output.state(idle))
        await this.outputTail
      }
      this.inflight = undefined
      if (outcome.kind === 'stopped') inflight.resolve(outcome.stopReason)
      else inflight.reject(internalError(outcome.detail))
    })()
      /* v8 ignore start -- admissionDone only resolves; idle/output gates contain their own failures. */
      .catch(async (error: unknown) => {
        if (this.inflight !== inflight) return
        if (inflight.committed) {
          this.enqueue(() => this.output.state(idleState('error', errorChain(error))))
          await this.outputTail
        }
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }
}

/** How a settled prompt ended: a stop reason, or a failure with its request-error detail. */
type PromptOutcome =
  | { kind: 'stopped'; stopReason: StopReason }
  | { kind: 'failed'; message: string; detail: string }

/** Decide a settled prompt's outcome; cancellation, then delivery, interval, and turn failures take precedence in that order. */
function settlementOf(inflight: InflightPrompt): PromptOutcome {
  if (inflight.admissionController.signal.aborted) return { kind: 'stopped', stopReason: 'cancelled' }
  if (inflight.outputError !== undefined) {
    return { kind: 'failed', message: inflight.outputError.message, detail: `output delivery failed: ${inflight.outputError.message}` }
  }
  if (inflight.agentError !== undefined) {
    return { kind: 'failed', message: inflight.agentError.message, detail: `turn failed: ${inflight.agentError.message}` }
  }
  const end = inflight.endReason
  // A message removed before its turn claimed it ended no turn of its own.
  if (end === undefined) return { kind: 'stopped', stopReason: 'cancelled' }
  if (end.kind === 'error') return { kind: 'failed', message: end.error.message, detail: `turn failed: ${end.error.message}` }
  return { kind: 'stopped', stopReason: turnEndToStopReason(end) }
}

/** Render goal state for clients that support standard assistant text updates. */
function formatGoal(goal: GoalView): string {
  return `Goal ${goal.phase} (${goal.activation}): ${goal.objective}\nRounds: ${goal.roundsStarted}/${goal.maxGoalRounds}.`
    + (goal.blockedReason === undefined ? '' : `\nBlocked: ${goal.blockedReason.message}`)
}
