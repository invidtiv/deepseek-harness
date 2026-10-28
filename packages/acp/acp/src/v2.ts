/** Draft ACP v2 projections; no v2 objects escape the ACP package. */

import { randomUUID } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { RequestError, type AvailableCommand, type ContentBlock, type McpServer, type SessionConfigOption } from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type {} from '@deepseek-ai/dsh-session-title'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { assistantBlockToAcp } from './content.ts'
import type { AcpOutput } from './output.ts'
import { AcpToolCursor } from './tool-projection.ts'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from './updates.ts'

/**
 * Admit only content understood by the shared Harness content adapter.
 * @param blocks - validated, extensible v2 content.
 * @returns supported content for Harness admission.
 */
export function promptContent(blocks: readonly v2.ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (v2.ContentBlock.isText(block)) return { type: 'text', text: block.text }
    if (v2.ContentBlock.isImage(block)) return { type: 'image', data: block.data, mimeType: block.mimeType }
    if (v2.ContentBlock.isResourceLink(block)) return { type: 'resource_link', name: block.name, uri: block.uri }
    throw RequestError.invalidParams(undefined, `unsupported prompt content: ${block.type}`)
  })
}

/**
 * Resolve the supported MCP transports, rejecting unknown and unadvertised variants.
 * @param servers - requested v2 mounts.
 * @returns declarations consumed by the shared MCP adapter.
 */
export function mcpServers(servers: readonly v2.McpServer[] | null | undefined): McpServer[] {
  return (servers ?? []).map((server) => {
    if (v2.McpServer.isHttp(server)) return { type: 'http', name: server.name, url: server.url, headers: server.headers ?? [] }
    if (v2.McpServer.isStdio(server)) {
      return { name: server.name, command: server.command, args: server.args ?? [], env: server.env ?? [] }
    }
    throw RequestError.invalidParams(undefined, 'unsupported MCP transport')
  })
}

/**
 * Project the shared model selectors with v2 identifiers.
 * @param options - complete Harness model configuration.
 * @returns complete v2 configuration replacement.
 */
export function configOptions(options: readonly SessionConfigOption[]): v2.SessionConfigOption[] {
  return options.map(({ id, ...option }) => {
    if (option.type !== 'select') throw RequestError.internalError(undefined, 'unsupported Harness configuration type')
    return {
      ...option,
      configId: id,
      options: option.options.map(choice => 'group' in choice
        ? { groupId: choice.group, name: choice.name, options: choice.options }
        : choice) as v2.SessionConfigSelectOptions,
    }
  })
}

/**
 * Project command discovery with explicit text-input discriminants.
 * @param commands - standard command descriptors.
 * @returns v2 command descriptors.
 */
export function availableCommands(commands: readonly AvailableCommand[]): v2.AvailableCommand[] {
  return commands.map(({ name, description, input }) => ({
    name, description,
    ...input == null ? {} : { input: { type: 'text', hint: input.hint } },
  }))
}

/**
 * Project an inserted Harness message, retaining its canonical identity.
 * @param ctx - attachment-owning context.
 * @param message - accepted or restored user message.
 * @returns a whole-message upsert, also safe to replay.
 */
export async function userUpdate(ctx: Context, message: UserMessage): Promise<v2.SessionUpdate> {
  const content: v2.ContentBlock[] = []
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push(converted)
  }
  return { sessionUpdate: 'user_message', messageId: message.id, content }
}

/**
 * Project committed events into v2 updates with stable message identities.
 * @param ctx - attachment and usage services.
 * @param session - authoritative session.
 * @param event - durable semantic event, never a provider delta.
 * @param cursor - ordered tool-call cursor shared across replay pages.
 * @returns ordered message chunks; live delivery and replay share this projection.
 */
export async function eventUpdates(
  ctx: Context, session: Session, event: SessionEvent, cursor?: AcpToolCursor,
): Promise<v2.SessionUpdate[]> {
  const call = cursor?.accept(session, event)
  const toolContext = ctx.get('agents')?.get(session.id)?.ctx ?? ctx
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'user' ? [await userUpdate(ctx, event.data)] : []
    case 'assistant/message': {
      const updates: v2.SessionUpdate[] = []
      for (const update of await assistantUpdates(ctx, session, event)) {
        if (update.sessionUpdate === 'agent_message_chunk') {
          updates.push({ ...update, messageId: event.data.message.id })
        } else if (update.sessionUpdate === 'agent_thought_chunk') {
          updates.push({ ...update, messageId: `${event.data.message.id}:thought` })
        } else updates.push(update)
      }
      return updates
    }
    case 'session/title': return [{ sessionUpdate: 'session_info_update', title: event.data.title }]
    case 'tool/call':
      return [{ ...projectToolCall(toolCallUpdate(event, toolContext, call)), sessionUpdate: 'tool_call_update' }]
    case 'tool/result':
      return [{ ...projectToolCall(await toolResultUpdate(toolContext, event, call)), sessionUpdate: 'tool_call_update' }]
    default:
      // Session events are merge-extensible; only conversation facts have transcript output.
      return []
  }
}

/**
 * Convert stable tool content into v2's structured file-change vocabulary.
 * @param update - shared tool presentation or permission subject.
 * @returns v2 tool fields without an update discriminator.
 */
export function projectToolCall(update: ToolCallUpdate): v2.ToolCallUpdate {
  const { content, ...fields } = update
  return {
    ...fields,
    ...content == null ? {} : { content: content.map((item) => {
      if (item.type !== 'diff') return item
      return {
        type: 'diff' as const,
        changes: [{ operation: 'modify' as const, path: item.path, fileType: 'text' as const }],
        patch: { format: 'git_patch', text: createTwoFilesPatch(item.path, item.path, item.oldText ?? '', item.newText) },
      }
    }) },
  }
}

/**
 * Build draft-v2 delivery for one session.
 * @param ctx - attachment and usage services.
 * @param sessionId - session addressed by every notification.
 * @param notify - ordered transport write that contains its own failure.
 * @returns v2 delivery, including foreground states.
 */
export function v2Output(
  ctx: Context,
  sessionId: SessionId,
  notify: (notification: v2.UpdateSessionNotification) => Promise<void>,
): AcpOutput {
  const cursor = new AcpToolCursor()
  const send = (update: v2.SessionUpdate): Promise<void> => notify({ sessionId, update })
  return {
    async event(session, event) {
      for (const update of await eventUpdates(ctx, session, event, cursor)) await send(update)
    },
    toolOutput: (toolCallId, text) => send({ sessionUpdate: 'tool_call_content_chunk', toolCallId, content: { type: 'content', content: { type: 'text', text } } }),
    plan: entries => send({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'todos', entries: [...entries] } }),
    configOptions: options => send({ sessionUpdate: 'config_option_update', configOptions: configOptions(options) }),
    commands: commands => send({ sessionUpdate: 'available_commands_update', availableCommands: availableCommands(commands) }),
    status: (messageId, text) => send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }),
    async commandResult(messageId, _line, text) {
      await send({ sessionUpdate: 'agent_message_chunk', messageId: `${messageId}:result`, content: { type: 'text', text } })
    },
    async state(state) {
      switch (state.state) {
        case 'running': return send({ sessionUpdate: 'state_update', state: 'running' })
        case 'requires_action': return send({ sessionUpdate: 'state_update', state: 'requires_action' })
        case 'idle':
          if (state.stopReason === 'error') {
            await send({ sessionUpdate: 'agent_message_chunk', messageId: `error:${randomUUID()}`, content: { type: 'text', text: `Turn failed: ${state.error ?? 'The agent could not complete this turn.'}` } })
          }
          return send({
            sessionUpdate: 'state_update', state: 'idle',
            ...state.stopReason === undefined ? {} : { stopReason: state.stopReason },
            ...state.error === undefined ? {} : { _meta: { error: state.error } },
          })
        /* v8 ignore next -- ForegroundState is a closed same-process union. */
        default: return assertNever(state)
      }
    },
  }
}
