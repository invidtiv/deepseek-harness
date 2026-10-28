/** Registered tool presenters projected into ACP cards and permission subjects. */
import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ProjectionHandle, ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { z } from 'zod'
import { assertNever } from '@deepseek-ai/dsh-util-values'

const callSchema = z.object({ name: z.string(), arguments: z.string(), cwd: z.string().nullable() })
type Call = z.infer<typeof callSchema>
const stateSchema = z.object({ cwd: z.string().nullable(), calls: z.record(z.string(), callSchema) })
type State = z.infer<typeof stateSchema>
const definition: ProjectionDefinition<'acpToolCalls', State> = {
  key: 'acpToolCalls', stateVersion: 1, stateSchema,
  init: header => ({ cwd: header.cwd ?? null, calls: {} }),
  apply(state, event) {
    if (event.type === 'working-directory/change') return { ...state, cwd: event.data.cwd }
    if (event.type === 'tool/call') return { ...state, calls: { ...state.calls, [event.data.callId]: { name: event.data.name, arguments: event.data.arguments, cwd: state.cwd } } }
    if (event.type === 'step/end' || event.type === 'turn/end') return { ...state, calls: {} }
    return state
  },
}

/** One bridge-owned reader of pending calls; registration unwinds with its plugin. */
export class AcpToolProjection {
  private constructor(private readonly handle: ProjectionHandle<State>) {}
  /**
   * Register the bounded current-step call projection before exposing ACP handlers.
   * @param ctx - bridge context with the projection registry.
   * @returns the owner of permission-subject projection.
   */
  static async create(ctx: Context): Promise<AcpToolProjection> {
    return new AcpToolProjection(await ctx.sessionProjections.register(definition))
  }
  /**
   * Identify a repeatable pending invocation without granting by tool name alone.
   * @param agent - owner of the pending invocation.
   * @param callId - exact pending invocation.
   * @param toolName - name reported by the approval requester.
   * @returns exact arguments and effective directory, or undefined for an unverified call.
   */
  permissionGrantKey(agent: Agent, callId: string, toolName: string): string | undefined {
    const state = this.handle.stateOf(agent.session)
    const call = state.calls[callId]
    return call?.name === toolName && state.cwd !== null
      ? JSON.stringify([call.name, call.arguments, state.cwd]) : undefined
  }
  /**
   * Describe exactly the pending invocation; missing calls remain unclassified.
   * @param agent - requesting agent and scoped tool registry.
   * @param callId - exact pending invocation.
   * @param toolName - name reported by the approval requester.
   * @returns permission subject with the same metadata as the call card.
   */
  permissionToolCall(agent: Agent, callId: string, toolName: string): ToolCall {
    const state = this.handle.stateOf(agent.session)
    const call = state.calls[callId]
    return projectCall(agent.ctx, callId, call?.name === toolName ? { ...call, cwd: state.cwd } : { name: toolName, arguments: '', cwd: null })
  }
}

/** Ordered output cursor; the same fold supports live delivery and paginated replay. */
export class AcpToolCursor {
  private state: State | undefined
  /**
   * Fold one ordered output event and return its invocation, if any.
   * @param session - header providing the initial directory.
   * @param event - event at the output cursor.
   * @returns associated call facts, bounded to the current step.
   */
  accept(session: Session, event: SessionEvent): Call | undefined {
    this.state = definition.apply(this.state ?? { cwd: session.header.cwd ?? null, calls: {} }, event)
    const id = event.type === 'tool/call' ? event.data.callId : event.type === 'tool/result' ? event.data.message.toolCallId : undefined
    return id === undefined ? undefined : this.state.calls[id]
  }
}

/** Resolve a presentation path in the execution world's path syntax. */
function absolute(path: string, cwd: string | null): string {
  const paths = cwd !== null && win32.isAbsolute(cwd) && !posix.isAbsolute(cwd) ? win32 : posix
  return paths.isAbsolute(path) || cwd === null ? path : paths.resolve(cwd, path)
}
/** Preserve malformed model arguments without inventing semantic fields. */
function argumentsOf(text: string): unknown {
  try { return JSON.parse(text) } catch (_invalidModelJson) { return text }
}
/** Resolve a registered presenter in the caller's agent scope. */
function tool(ctx: Context, name: string): ToolDefinition | undefined { return ctx.get('tools')?.get(name, scopeOf(ctx)) }

/**
 * Convert a registered call presenter without interpreting tool-specific arguments.
 * @param ctx - agent-scoped context, or bridge context for detached replay.
 * @param callId - invocation identity.
 * @param call - durable name, arguments and execution directory.
 * @returns ACP call metadata, retaining a generic unknown-tool fallback.
 */
export function projectCall(ctx: Context, callId: string, call: Call): ToolCall {
  const args = argumentsOf(call.arguments)
  const view = tool(ctx, call.name)?.presentCall?.(args)
  const base: ToolCall = { toolCallId: callId, name: call.name, title: view?.title ?? call.name, kind: 'other', status: 'in_progress', rawInput: args }
  if (view === undefined) return base
  switch (view.card) {
    case 'generic': return { ...base, kind: view.kind ?? 'other', ...view.locations === undefined ? {} : { locations: view.locations.map(location => ({ ...location, path: absolute(location.path, call.cwd) })) } }
    case 'terminal': return { ...base, kind: 'execute' }
    case 'diff': return { ...base, kind: 'edit', locations: (view.locations ?? view.diffs.map(diff => ({ path: diff.path }))).map(location => ({ ...location, path: absolute(location.path, call.cwd) })), content: view.diffs.map(diff => ({ type: 'diff', ...diff, path: absolute(diff.path, call.cwd) })) }
    default: return assertNever(view)
  }
}

/**
 * Project provider-owned result metadata; failed tools retain their failure status.
 * @param ctx - agent-scoped tool registry.
 * @param call - original invocation at the output cursor.
 * @param event - committed result, including opaque presenter metadata.
 * @returns supplemental ACP fields, or none for missing/obsolete presenters.
 */
export function projectResult(ctx: Context, call: Call | undefined, event: SessionEvent<'tool/result'>): Partial<ToolCallUpdate> {
  if (call === undefined) return {}
  const message = event.data.message
  const view = tool(ctx, call.name)?.presentResult?.(argumentsOf(call.arguments), {
    content: [...message.content], isError: message.isError === true,
    ...event.data.meta === undefined ? {} : { meta: event.data.meta },
  })
  if (view === undefined) return {}
  // A metadata-only rawOutput hides content in clients that prefer structured output.
  if (view.card === 'terminal' && view.output === undefined) {
    const output = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    return resultFields({ ...view, output }, call.cwd)
  }
  return resultFields(view, call.cwd)
}
/** Map presentation variants, never tool names or opaque tool metadata. */
function resultFields(view: ToolResultView, cwd: string | null): Partial<ToolCallUpdate> {
  const title = view.title === undefined ? {} : { title: view.title }
  switch (view.card) {
    case 'terminal': return { ...title, kind: 'execute', rawOutput: { ...view.output === undefined ? {} : { output: view.output }, ...view.exitCode === undefined ? {} : { exitCode: view.exitCode }, ...view.signal === undefined ? {} : { signal: view.signal } } }
    case 'diff': return { ...title, kind: 'edit', content: view.diffs.map(diff => ({ type: 'diff', ...diff, path: absolute(diff.path, cwd) })), locations: view.diffs.map(diff => ({ path: absolute(diff.path, cwd) })) }
    case 'read': return { ...title, kind: 'read', locations: [{ path: absolute(view.path, cwd), line: view.offset }], rawOutput: view }
    case 'search': return { ...title, kind: 'search', rawOutput: view }
    case 'web': return { ...title, kind: view.kind, rawOutput: view }
    case 'generic': return title
    default: return assertNever(view)
  }
}
