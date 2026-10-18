/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { assistantBlockToAcp } from './content.ts'

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
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
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
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): Pick<ToolCall, 'toolCallId' | 'title' | 'kind' | 'status' | 'rawInput'> & { sessionUpdate: 'tool_call' } {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<Omit<ToolCallUpdate, 'content'> & { sessionUpdate: 'tool_call_update'; content: Extract<ToolCallContent, { type: 'content' }>[] }> {
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
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
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
 * Project the standing task list into ACP's complete plan replacement.
 * @param event - committed task-list write or turn reset.
 * @returns the standard plan, including an empty replacement at a new turn.
 */
export function planUpdate(event: SessionEvent<'todo/write' | 'turn/start'>): Extract<SessionUpdate, { sessionUpdate: 'plan' }> {
  return {
    sessionUpdate: 'plan' as const,
    entries: event.type === 'todo/write'
      ? event.data.todos.map(item => ({ ...item, priority: 'medium' as const })) : [],
  }
}

/**
 * Replay retained conversation facts using stable ACP updates.
 * @param ctx - attachment and usage services.
 * @param session - restored session.
 * @param event - committed event to project.
 * @returns ordered updates; non-conversation events have no transcript output.
 */
export async function replayUpdates(ctx: Context, session: Session, event: SessionEvent): Promise<SessionUpdate[]> {
  switch (event.type) {
    case 'user/message': {
      if (event.data.source.kind !== 'user') return []
      const updates: SessionUpdate[] = []
      for (const block of event.data.content) {
        const content = await assistantBlockToAcp(ctx, block)
        if (content !== undefined) updates.push({ sessionUpdate: 'user_message_chunk', messageId: event.data.id, content })
      }
      return updates
    }
    case 'assistant/message': return assistantUpdates(ctx, session, event)
    case 'tool/call': return [toolCallUpdate(event)]
    case 'tool/result': return [await toolResultUpdate(ctx, event)]
    case 'todo/write':
      return [planUpdate(event)]
    default:
      // Session events are merge-extensible; only retained conversation facts are replayed.
      return []
  }
}
