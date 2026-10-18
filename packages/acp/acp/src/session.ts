/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */

import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import {
  RequestError,
  type AvailableCommand,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent, type SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { AcpContentError, admitAcpPrompt } from './content.ts'
import { turnEndToStopReason } from './codec.ts'
import { mountAcpMcpServers } from './mcp.ts'
import { AcpModelControl } from './model-control.ts'
import { assistantUpdates, planUpdate, replayUpdates, toolCallUpdate, toolResultUpdate } from './updates.ts'
import type * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { configOptions as configOptionsV2, eventUpdates, userUpdate } from './v2.ts'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'

/** The continuable-subagent teardown used without depending on the subagent package. */
interface ContinuableDrain {
  /** Dispose continuable descendants below exact host-owned parents child-first. */
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/** Inputs shared by fresh and resumed ACP session construction. */
interface AcpSessionBuildOptions {
  cwd: string
  mcpServers: readonly McpServer[]
  agentOptions: AgentOptions
  fallbackSelection: ModelSelection | undefined
  signal: AbortSignal
  notify: (notification: SessionNotification) => Promise<void>
  notifyV2?: ((notification: v2.UpdateSessionNotification) => Promise<void>) | undefined
}

/** Fresh ACP session construction inputs. */
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** Persisted ACP session construction inputs. */
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  completionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancelRequested: boolean
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

/** A command stopped by `session/cancel`, request cancellation, or session close before it settled. */
class AcpCommandCancelled extends Error {
  constructor() { super('ACP command cancelled') }
}

/** Terminal v2 foreground state; failure detail travels in metadata, never as transcript text. */
function idleUpdate(stopReason: v2.StopReason, failure?: string): v2.SessionUpdate {
  return { sessionUpdate: 'state_update', state: 'idle', stopReason, ...failure === undefined ? {} : { _meta: { error: failure } } }
}

/** Restore the latest logged route before falling back to deployment config. */
function selectionFor(
  logged: {
    config: { provider: string; model: string; reasoningEffort?: ModelSelection['reasoningEffort'] }
    adapterDefaults?: { reasoningEffort?: boolean }
  } | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  return logged === undefined
    ? fallback
    : {
      provider: logged.config.provider,
      model: logged.config.model,
      ...logged.config.reasoningEffort === undefined || logged.adapterDefaults?.reasoningEffort === true
        ? {}
        : { reasoningEffort: logged.config.reasoningEffort },
    }
}

/**
 * Per-session ACP module. It owns the unpublished Agent composition, selected
 * route, one-prompt admission slot, ordered standard updates, and memoized
 * quiescent teardown.
 */
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent
  private readonly modelControl: AcpModelControl
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private autonomousEnding: TurnEndReason | undefined
  private autonomousCancelled = false
  private pendingPermissions = 0
  private closing: Promise<void> | undefined
  private command: { controller: AbortController; done: Promise<void> } | undefined
  private readonly pendingSelections = new Map<string, ModelSelection>()

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    modelControl: AcpModelControl,
    private readonly notify: (notification: SessionNotification) => Promise<void>,
    private readonly notifyV2?: (notification: v2.UpdateSessionNotification) => Promise<void>,
  ) {
    this.agent = handle.agent
    this.modelControl = modelControl
    this.disposeAgent = () => handle.dispose()
  }

  private readonly disposeAgent: () => Promise<void>

  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - fresh session identity, workspace, route, MCP, and notifier.
   * @returns the fully composed per-session module.
   */
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection)
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx) => {
        modelControl.install(agentCtx)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    return new AcpSession(ctx, handle, modelControl, options.notify, options.notifyV2)
  }

  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - persisted identity, workspace, fallback route, MCP, and notifier.
   * @returns the restored per-session module.
   */
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    let modelControl: AcpModelControl | undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx, agent) => {
        modelControl = new AcpModelControl(
          ctx.llm,
          selectionFor(agent.session.requestHeader(), options.fallbackSelection),
        )
        modelControl.install(agentCtx)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    /* v8 ignore start -- a fulfilled Agent resume necessarily ran setup to completion. */
    if (modelControl === undefined) {
      await handle.dispose()
      throw internalError('session/resume did not compose model selection')
    }
    /* v8 ignore stop */
    return new AcpSession(ctx, handle, modelControl, options.notify, options.notifyV2)
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
   * Return the complete standard model configuration state.
   * @param signal - optional request cancellation.
   * @returns provider-grouped model and exact-model reasoning options.
   */
  configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.options(signal)
  }

  /**
   * Apply one standard configuration option to later ACP turns.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional request cancellation.
   * @returns the complete resulting option state.
   */
  setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.set(configId, value, signal)
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged(): void {
    if (this.closing !== undefined) return
    void this.modelControl.options()
      .then((configOptions) => {
        if (this.closing !== undefined) return
        if (this.notifyV2 !== undefined) {
          this.enqueueV2(() => [{ sessionUpdate: 'config_option_update', configOptions: configOptionsV2(configOptions) }])
          return
        }
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({
            sessionId: this.agent.session.id,
            update: { sessionUpdate: 'config_option_update', configOptions },
          }))
          /* v8 ignore start -- the bridge notifier contains transport failure. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
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

  /**
   * Project command discovery for draft v2.
   * @returns commands with explicit text-input discriminants.
   */
  availableCommandsV2(): v2.AvailableCommand[] {
    return this.availableCommands().map(({ name, description, input }) => ({
      name, description,
      ...input == null ? {} : { input: { type: 'text', hint: input.hint } },
    }))
  }

  /** Publish a complete replacement command list after registry changes. */
  commandsChanged(): void {
    if (this.closing !== undefined) return
    const availableCommands = this.availableCommands()
    if (this.notifyV2 !== undefined) {
      this.enqueueV2(() => [{ sessionUpdate: 'available_commands_update', availableCommands: this.availableCommandsV2() }])
    } else {
      this.outputTail = this.outputTail.then(() => this.notify({
        sessionId: this.agent.session.id,
        update: { sessionUpdate: 'available_commands_update', availableCommands },
      }))
    }
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
    if (status === 'running') {
      this.enqueueV2(() => [{ sessionUpdate: 'state_update', state: 'running' }])
    }
    if (status === 'idle') {
      const ending = this.autonomousEnding
      const update = this.autonomousCancelled || ending === undefined ? idleUpdate('cancelled')
        : ending.kind === 'error' ? idleUpdate('error', ending.error.message) : idleUpdate(turnEndToStopReason(ending))
      this.enqueueV2(() => [update])
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
    signal.throwIfAborted()
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
        this.enqueueV2(() => [{ sessionUpdate: 'user_message', messageId, content: [{ type: 'text', text: line }] }])
        const text = execution.result.text ?? ''
        if (this.notifyV2 !== undefined) {
          this.enqueueV2(() => [
            { sessionUpdate: 'agent_message_chunk', messageId: `${messageId}:result`, content: { type: 'text', text } },
            ...this.inflight === undefined && this.agent.status === 'idle'
              ? [{ sessionUpdate: 'state_update' as const, state: 'idle' as const, stopReason: 'end_turn' as const }] : [],
          ])
        } else {
          this.outputTail = this.outputTail.then(() => this.notify({
            sessionId: this.agent.session.id,
            update: { sessionUpdate: 'agent_message_chunk', messageId: `${messageId}:result`, content: { type: 'text', text } },
          }))
        }
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
   * @param accepted - optional insertion observer; request cancellation stops owning the message after this callback.
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
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      completionDone: completion.promise.then(() => {}, () => {}),
      finishAdmission: admission.resolve,
      admissionController,
      cancelRequested: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    this.inflight = inflight
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    requestSignal.addEventListener('abort', onRequestAbort, { once: true })
    /* v8 ignore next -- the SDK dispatches a live signal, then notifies abort through its listener. */
    if (requestSignal.aborted) onRequestAbort()
    try {
      let admissionFailure: unknown
      const promptSelection = this.modelControl.snapshot()
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
        if (promptSelection !== undefined) this.pendingSelections.set(message.id, promptSelection)
        try {
          this.agent.followup(message)
          if (accepted !== undefined) {
            requestSignal.removeEventListener('abort', onRequestAbort)
            accepted(message)
          }
        } catch (error: unknown) {
          inflight.messageQueued = false
          this.pendingSelections.delete(message.id)
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.cancelRequested) {
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
   * Return the inserted message identity while completion travels through v2 state updates.
   * @param params - admitted prompt fields shared with v1.
   * @param imageEnabled - negotiated image capability.
   * @param signal - cancellation before insertion only.
   * @returns the canonical inbox ID before model completion, or a live-only command ID after execution.
   */
  promptV2(params: PromptRequest, imageEnabled: boolean, signal: AbortSignal): Promise<v2.PromptResponse> {
    const command = this.runCommand(params, signal)
    if (command !== undefined) {
      return command.then(messageId => ({ messageId }), (error: unknown) => {
        // A cancelled command echoed nothing, so the request fails like a prompt cancelled before insertion.
        throw error instanceof AcpCommandCancelled ? invalidParams('command cancelled before completion') : error
      })
    }
    const acceptance = Promise.withResolvers<v2.PromptResponse>()
    let inserted = false
    void this.prompt(params, imageEnabled, signal, (message) => {
      inserted = true
      this.enqueueV2(async () => [await userUpdate(this.ctx, message), { sessionUpdate: 'state_update', state: 'running' }])
      acceptance.resolve({ messageId: message.id })
    }).then(
      () => { if (!inserted) acceptance.reject(invalidParams('prompt cancelled before insertion')) },
      (error: unknown) => { if (!inserted) acceptance.reject(error) },
    )
    return acceptance.promise
  }

  /**
   * Bracket foreground and autonomous permission exchanges with activity states.
   * @param answer - transport exchange; policy remains with the approval service.
   * @returns the client's answer after the corresponding state transition.
   */
  async withPermission<T>(answer: () => Promise<T>): Promise<T> {
    const owner = this.inflight
    this.pendingPermissions++
    if (owner?.cancelRequested !== true && !this.autonomousCancelled) {
      this.enqueueV2(() => [{ sessionUpdate: 'state_update', state: 'requires_action' }])
    }
    await this.outputTail
    try {
      return await answer()
    } finally {
      this.pendingPermissions--
      if (this.inflight === owner && owner?.cancelRequested !== true && !this.autonomousCancelled
        && this.pendingPermissions === 0 && this.closing === undefined) {
        this.enqueueV2(() => [{ sessionUpdate: 'state_update', state: 'running' }])
        await this.outputTail
      }
    }
  }

  /**
   * Replay retained conversation facts, including every standing-plan replacement.
   * @param reader - persisted reader owned by the caller.
   * @param pageSize - maximum events fetched per storage read.
   * @param signal - activation request cancellation.
   * @returns completion after all retained updates have been delivered.
   */
  async replay(reader: SessionHandle, pageSize: number, signal: AbortSignal): Promise<void> {
    const end = this.agent.session.seq
    const replay = this.outputTail.then(async () => {
      let planVisible = false
      for (let offset = 0; offset < end;) {
        signal.throwIfAborted()
        const { events } = await reader.read(offset, Math.min(pageSize, end - offset), { signal })
        if (events.length === 0) throw internalError('session replay is missing persisted events')
        for (const event of events) {
          signal.throwIfAborted()
          if (event.type === 'turn/start' && planVisible) {
            const entries: [] = []
            if (this.notifyV2 !== undefined) await this.notifyV2({ sessionId: this.agent.session.id,
              update: { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'todos', entries } },
            })
            else await this.notify({ sessionId: this.agent.session.id, update: { sessionUpdate: 'plan', entries } })
            planVisible = false
          }
          if (event.type === 'todo/write') planVisible = event.data.todos.length > 0
          if (this.notifyV2 !== undefined) {
            for (const update of await eventUpdates(this.ctx, this.agent.session, event)) {
              await this.notifyV2({ sessionId: this.agent.session.id, update })
            }
          } else {
            for (const update of await replayUpdates(this.ctx, this.agent.session, event)) {
              await this.notify({ sessionId: this.agent.session.id, update })
            }
          }
        }
        offset += events.length
      }
      // The replayed tail is the client's current plan; the next turn start clears it.
      this.planVisible = planVisible
    })
    this.outputTail = replay.catch(() => {})
    await replay
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
      const todos = this.ctx.get('sessionProjections')?.stateOf(this.agent.session, 'todos')
      if (todos != null) this.sendPlan({ sessionUpdate: 'plan', entries: todos.map(item => ({ ...item, priority: 'medium' })) })
    }
    await this.outputTail
  }

  /**
   * Report the idle v2 foreground state of a session that has just been restored.
   * @returns completion once the state has been delivered behind restored progress.
   */
  async announceIdle(): Promise<void> {
    this.enqueueV2(() => [{ sessionUpdate: 'state_update', state: 'idle' }])
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
    if (this.notifyV2 !== undefined) {
      this.enqueueV2(() => [{ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }])
    } else {
      // V1 clients may fold every text chunk into one answer regardless of message id;
      // the trailing newline keeps a status line separate from adjacent text.
      this.outputTail = this.outputTail.then(() => this.notify({ sessionId: this.agent.session.id,
        update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: `${text}\n` } },
      }))
    }
  }

  private goalText: string | undefined
  private planVisible = false

  private sendPlan(update: ReturnType<typeof planUpdate>): void {
    this.planVisible = update.entries.length > 0
    if (this.notifyV2 !== undefined) this.enqueueV2(() => [{ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'todos', entries: update.entries } }])
    else this.outputTail = this.outputTail.then(() => this.notify({ sessionId: this.agent.session.id, update }))
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
    try {
      if (event.type === 'todo/write' || event.type === 'turn/start') {
        if (event.type === 'todo/write' || this.planVisible) this.sendPlan(planUpdate(event))
        return
      }
      if (this.notifyV2 !== undefined) {
        // The insertion acknowledgement owns the live user echo; replay reads user/message.
        if (event.type !== 'user/message') this.enqueueV2(() => eventUpdates(this.ctx, session, event))
        return
      }
      if (event.type === 'assistant/message') {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (event.type === 'tool/call') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'tool/result') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(async () => this.notify({
            sessionId: this.agent.session.id,
            update: await toolResultUpdate(this.ctx, event),
          }))
          /* v8 ignore start -- supplemental-content conversion failure is contained and cannot fail Agent work. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      }
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
      if (event.type === 'turn/end') {
        this.autonomousEnding = event.data.reason
        this.modelControl.releaseTurn(event.data.turn)
      }
    }
  }

  /**
   * Correlate an accepted user message with its Agent turn and pinned route.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
    const selection = this.pendingSelections.get(message.id) ?? this.modelControl.snapshot()
    this.pendingSelections.delete(message.id)
    if (selection !== undefined) this.modelControl.pinTurn(turn, selection)
  }

  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param turn - failed turn number.
   * @param error - original same-process failure.
   */
  onAgentError(turn: number, error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // AgentLoop balances an in-turn failure with durable turn/end; settlement
    // reads that exact error reason. This slot records interval failures outside it.
    if (inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
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
      const subagents = this.ctx.get('subagents') as ContinuableDrain | undefined
      try {
        await subagents?.drainContinuableDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: continuable subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('continuable subagent teardown failed', { cause: error }))
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
      this.pendingSelections.clear()
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

  private enqueueV2(updates: () => v2.SessionUpdate[] | Promise<v2.SessionUpdate[]>): void {
    if (this.notifyV2 === undefined) return
    const inflight = this.inflight
    this.outputTail = this.outputTail.then(async () => {
      for (const update of await updates()) await this.notifyV2?.({ sessionId: this.agent.session.id, update })
    }).catch((error: unknown) => {
      if (inflight !== undefined) inflight.outputError ??= new Error(errorChain(error))
      this.ctx.logger.warn(`acp: v2 update failed: ${errorChain(error)}`)
    })
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    inflight.cancelRequested = true
    inflight.admissionController.abort(new Error(detail))
    this.settleAfterQuiescence(inflight)
    if (inflight.messageQueued) this.agent.cancel({ kind: 'user' })
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        await this.agent.whenIdle()
        await this.outputTail
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (this.inflight !== inflight) return
      if (this.notifyV2 !== undefined && inflight.messageQueued) {
        const end = inflight.endReason
        const failure = inflight.outputError ?? inflight.agentError ?? (end?.kind === 'error' ? end.error : undefined)
        const update = inflight.cancelRequested ? idleUpdate('cancelled')
          : failure !== undefined ? idleUpdate('error', failure.message)
            : end === undefined ? idleUpdate('cancelled') : idleUpdate(turnEndToStopReason(end))
        this.enqueueV2(() => [update])
        await this.outputTail
      }
      this.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
      /* v8 ignore start -- admissionDone only resolves; idle/output gates contain their own failures. */
      .catch(async (error: unknown) => {
        if (this.inflight !== inflight) return
        if (inflight.messageQueued) {
          this.enqueueV2(() => [idleUpdate('error', errorChain(error))])
          await this.outputTail
        }
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }
}

/** Render goal state for clients that support standard assistant text updates. */
function formatGoal(goal: GoalView): string {
  return `Goal ${goal.phase} (${goal.activation}): ${goal.objective}\nRounds: ${goal.roundsStarted}/${goal.maxGoalRounds}.`
    + (goal.blockedReason === undefined ? '' : `\nBlocked: ${goal.blockedReason.message}`)
}
