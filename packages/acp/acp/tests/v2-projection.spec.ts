/** Pure draft-v2 projection tests for paths the wire suites cannot reach deterministically. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { createUserMessage, MessageId, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { configOptions, eventUpdates, mcpServers, promptContent, userUpdate } from '../src/v2.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'v2-projection-test': { kind: 'v2-projection-test' } & ContextFormed
  }
}

// No attachment or token-meter services and no request context: projections take their plain paths.
const ctx = new Context()
const session = Session.create(SessionId('v2-projection'))

describe('draft v2 projections', () => {
  it('admits text, images and resource links and rejects other prompt content', () => {
    const blocks = [
      { type: 'text' as const, text: 'hi' },
      { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' },
      { type: 'resource_link' as const, name: 'spec', uri: 'file:///spec.md' },
    ]
    expect(promptContent(blocks)).toEqual(blocks)
    expect(() => promptContent([{ type: '_future' }])).toThrow('unsupported prompt content: _future')
  })

  it('maps HTTP and stdio MCP mounts with absent optional fields and rejects other transports', () => {
    expect(mcpServers(undefined)).toEqual([])
    expect(mcpServers([
      { type: 'http', name: 'web', url: 'https://example.test/mcp' },
      { type: 'stdio', name: 'local', command: '/bin/server' },
    ])).toEqual([
      { type: 'http', name: 'web', url: 'https://example.test/mcp', headers: [] },
      { name: 'local', command: '/bin/server', args: [], env: [] },
    ])
    expect(() => mcpServers([{ type: '_future', name: 'nested' }])).toThrow('unsupported MCP transport')
  })

  it('renames selector identifiers and refuses non-select options', () => {
    const grouped: SessionConfigOption = {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a',
      options: [{ group: 'p', name: 'P', options: [{ value: 'a', name: 'A' }] }],
    }
    const flat: SessionConfigOption = {
      id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'b', options: [{ value: 'b', name: 'B' }],
    }
    expect(configOptions([grouped, flat])).toEqual([
      { configId: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a', options: [{ groupId: 'p', name: 'P', options: [{ value: 'a', name: 'A' }] }] },
      { configId: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'b', options: [{ value: 'b', name: 'B' }] },
    ])
    expect(() => configOptions([{ id: 'flag', name: 'Flag', category: 'other', type: 'boolean', currentValue: true }]))
      .toThrow('unsupported Harness configuration type')
  })

  it('projects thoughts with a derived id, skips empty user blocks and ignores non-conversation events', async () => {
    const message = createUserMessage({ content: [{ type: 'text', text: '' }, { type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(await userUpdate(ctx, message)).toEqual({ sessionUpdate: 'user_message', messageId: message.id, content: [{ type: 'text', text: 'hi' }] })
    const assistant: SessionEvent<'assistant/message'> = {
      type: 'assistant/message', surfaceOp: 'append', seq: SessionSeq(0), time: 0,
      data: { stream: [], turn: 1, step: 1, message: {
        id: MessageId('a1'), role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }],
      } },
    }
    expect(await eventUpdates(ctx, session, assistant)).toEqual([
      { sessionUpdate: 'agent_thought_chunk', messageId: 'a1:thought', content: { type: 'text', text: 'think' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'answer' } },
    ])
    expect(await eventUpdates(ctx, session, { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } })).toEqual([])
    const injected = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'v2-projection-test' } })
    expect(await eventUpdates(ctx, session, { type: 'user/message', surfaceOp: 'append', seq: SessionSeq(2), time: 0, data: injected })).toEqual([])
  })
})
