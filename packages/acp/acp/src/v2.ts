/** Draft ACP v2 projections; no v2 objects escape the ACP package. */

import type { Context } from '@deepseek-ai/cordis'
import { RequestError, type ContentBlock, type McpServer, type SessionConfigOption } from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantBlockToAcp } from './content.ts'
import { assistantUpdates, planUpdate, toolCallUpdate, toolResultUpdate } from './updates.ts'

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
 * Project committed events using v2 replacement semantics.
 * @param ctx - attachment and usage services.
 * @param session - authoritative session.
 * @param event - durable semantic event, never a provider delta.
 * @returns ordered v2 upserts.
 */
export async function eventUpdates(ctx: Context, session: Session, event: SessionEvent): Promise<v2.SessionUpdate[]> {
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'user' ? [await userUpdate(ctx, event.data)] : []
    case 'assistant/message': {
      const content: v2.ContentBlock[] = []
      const thought: v2.ContentBlock[] = []
      const usage: v2.SessionUpdate[] = []
      for (const update of await assistantUpdates(ctx, session, event)) {
        if (update.sessionUpdate === 'agent_message_chunk') content.push(update.content)
        else if (update.sessionUpdate === 'agent_thought_chunk') thought.push(update.content)
        else if (update.sessionUpdate === 'usage_update') usage.push(update)
      }
      return [
        { sessionUpdate: 'agent_thought', messageId: `${event.data.message.id}:thought`, content: thought },
        { sessionUpdate: 'agent_message', messageId: event.data.message.id, content },
        ...usage,
      ]
    }
    case 'todo/write':
      return [{ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'todos', entries: planUpdate(event).entries } }]
    case 'tool/call':
      return [{ ...toolCallUpdate(event), sessionUpdate: 'tool_call_update' }]
    case 'tool/result':
      return [await toolResultUpdate(ctx, event)]
    default:
      // Session events are merge-extensible; only conversation facts have ACP output.
      return []
  }
}
