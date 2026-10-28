/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { PlanEntry, SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-session-title'
import { AcpToolCursor, projectCall, projectResult } from './tool-projection.ts'
import { assistantBlockToAcp } from './content.ts'

/** The standard updates one committed assistant message can produce. */
export type AssistantUpdate = Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'usage_update' }>

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<AssistantUpdate[]> {
  const updates: AssistantUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one ACP tool lifecycle using the registered provider presentation.
 * @param event - committed DSH tool-call event.
 * @param ctx - scoped tool registry; omitted when only generic presentation is available.
 * @param call - invocation and directory at the output cursor.
 * @returns the standard tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>, ctx?: Context, call?: ReturnType<AcpToolCursor['accept']>): ToolCall & { sessionUpdate: 'tool_call' } {
  return {
    sessionUpdate: 'tool_call',
    ...ctx === undefined ? {
      toolCallId: event.data.callId, name: event.data.name, title: event.data.name,
      kind: 'other', status: 'in_progress', rawInput: parseToolArguments(event.data.arguments),
    } : projectCall(ctx, event.data.callId, call ?? { name: event.data.name, arguments: event.data.arguments, cwd: null }),
  }
}

/**
 * Finish one ACP tool lifecycle from its committed result and presentation metadata.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @param call - original invocation at the output cursor.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
  call?: ReturnType<AcpToolCursor['accept']>,
): Promise<ToolCallUpdate & { sessionUpdate: 'tool_call_update' }> {
  const message = event.data.message
  const content: Extract<ToolCallContent, { type: 'content' }>[] = []
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content,
    ...projectResult(ctx, call, event),
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Extract<AssistantUpdate, { sessionUpdate: 'usage_update' }> | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}

/**
 * Project a standing task list into ACP's complete plan entries.
 * @param todos - the complete committed task list; empty clears the plan.
 * @returns standard entries with the default priority.
 */
export function planEntries(todos: readonly Omit<PlanEntry, 'priority'>[]): PlanEntry[] {
  return todos.map(item => ({ ...item, priority: 'medium' as const }))
}

/**
 * Project one committed conversation fact into stable ACP updates.
 * @param ctx - attachment and usage services.
 * @param session - authoritative session.
 * @param event - committed event to project.
 * @param replay - history replay; live delivery omits the user's own prompts, which the client sent.
 * @param cursor - ordered tool-call cursor shared across live delivery or replay pages.
 * @returns ordered updates; task lists and non-conversation events have no transcript output.
 */
export async function eventUpdates(
  ctx: Context, session: Session, event: SessionEvent, replay: boolean, cursor?: AcpToolCursor,
): Promise<SessionUpdate[]> {
  const call = cursor?.accept(session, event)
  const toolContext = ctx.get('agents')?.get(session.id)?.ctx ?? ctx
  switch (event.type) {
    case 'user/message': {
      if (!replay || event.data.source.kind !== 'user') return []
      const updates: SessionUpdate[] = []
      for (const block of event.data.content) {
        const content = await assistantBlockToAcp(ctx, block)
        if (content !== undefined) updates.push({ sessionUpdate: 'user_message_chunk', messageId: event.data.id, content })
      }
      return updates
    }
    case 'assistant/message': return assistantUpdates(ctx, session, event)
    case 'session/title': return [{ sessionUpdate: 'session_info_update', title: event.data.title }]
    case 'tool/call': return [toolCallUpdate(event, toolContext, call)]
    case 'tool/result': return [await toolResultUpdate(toolContext, event, call)]
    default:
      // Session events are merge-extensible; only conversation facts have transcript output.
      return []
  }
}
