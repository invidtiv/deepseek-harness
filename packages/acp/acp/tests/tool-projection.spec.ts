/** Tool-owned presentation and permission metadata through real ACP sessions. */
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

let harness: BridgeHarness | undefined
afterEach(async () => { await harness?.dispose() })

function invocation(name: string): StreamChunk[] {
  const id = ToolCallId('presented-call')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{"file":"sample.txt"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{"file":"sample.txt"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe.each([1, 2] as const)('ACP v%s registered tool presentation', (version) => {
  it.each(['edit', 'execute'] as const)('projects %s cards identically on paginated replay', async (kind) => {
    const notifications: v2.SessionUpdate[] = []
    let client: v2.ClientContext | undefined
    harness = await makeBridgeHarness({
      script: [invocation('custom'), textResponse('done')], config: { sessionReplayPageSize: 1 },
      ...version === 1 ? {} : { connectClient: (stream) => {
        client = v2.client().onNotification('session/update', ({ params }) => { notifications.push(params.update) }).connect(stream).agent
      } },
    })
    harness.ctx.tools.register(defineTool({
      name: 'custom', description: 'Present a custom operation.', parameters: { file: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }], presentationMeta: () => ({ marker: 'committed' }) },
      execute: async () => 'finished',
      presentCall: args => kind === 'edit'
        ? { card: 'diff', title: 'Edit sample', diffs: [{ path: args.file, oldText: 'before', newText: 'after' }] }
        : { card: 'terminal', title: 'echo marker' },
      presentResult: (_args, result) => {
        expect(result.meta).toEqual({ marker: 'committed' })
        return kind === 'edit'
          ? { card: 'diff', diffs: [{ path: 'sample.txt', oldText: 'before', newText: 'after' }] }
          : { card: 'terminal', output: 'marker', exitCode: 0 }
      },
    }))
    if (client === undefined) await harness.client.initialize({ protocolVersion: 1 })
    else await client.request('initialize', { protocolVersion: 2, info: { name: 'projection', version: '1' }, capabilities: {} })
    const { sessionId } = client === undefined
      ? await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      : await client.request('session/new', { cwd: process.cwd() })
    if (client === undefined) await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'run' }] })
    else {
      await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run' }] })
      await harness.ctx.agents.get(SessionId(sessionId))!.whenIdle()
      await vi.waitFor(() =>{  expect(notifications).toContainEqual(expect.objectContaining({ sessionUpdate: 'state_update', state: 'idle' })) })
    }
    // The agent's settled output queue is drained by closing before inspecting or replaying.
    if (client === undefined) await harness.client.closeSession({ sessionId })
    else await client.request('session/close', { sessionId })
    const updates = version === 1 ? harness.updates : notifications
    const calls = updates.filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ name: 'custom', kind, rawInput: { file: 'sample.txt' } })
    if (kind === 'execute') expect(calls[1]).toMatchObject({ rawOutput: { output: 'marker', exitCode: 0 } })
    else {
      expect(calls[0]).toHaveProperty('locations.0.path', join(process.cwd(), 'sample.txt'))
      expect(calls[1]).toMatchObject({ content: [expect.objectContaining({ type: 'diff' })] })
    }
    updates.length = 0
    if (client === undefined) await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    else await client.request('session/resume', { sessionId, cwd: process.cwd(), replayFrom: { type: 'start' } })
    expect(updates.filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')).toEqual(calls)
  })
})
it('uses scoped presenters and exact pending arguments for permissions, clearing settled calls', async () => {
  harness = await makeBridgeHarness()
  const { AcpToolProjection } = await import('../src/tool-projection.ts')
  const projection = await AcpToolProjection.create(harness.ctx)
  await harness.client.initialize({ protocolVersion: 1 })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  const agent = harness.ctx.agents.get(SessionId(sessionId))!
  const dispose = agent.ctx.tools.register(defineTool({
    name: 'scoped-read', description: 'Scoped read.', parameters: { file: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => '',
    presentCall: args => ({ card: 'generic', kind: 'read', title: `Read ${args.file}`, locations: [{ path: args.file }] }),
  }))
  const id = ToolCallId('permission-call')
  agent.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'scoped-read', arguments: '{"file":"sample.txt"}' })
  expect(projection.permissionToolCall(agent, id, 'scoped-read')).toMatchObject({
    kind: 'read', title: 'Read sample.txt', rawInput: { file: 'sample.txt' }, locations: [{ path: join(process.cwd(), 'sample.txt') }],
  })
  const recovered = join(process.cwd(), 'recovered')
  agent.session.append('working-directory/change', { cwd: recovered })
  expect(projection.permissionToolCall(agent, id, 'scoped-read')).toMatchObject({ locations: [{ path: join(recovered, 'sample.txt') }] })
  expect(projection.permissionToolCall(agent, id, 'different')).toMatchObject({ kind: 'other', title: 'different' })
  dispose()
  expect(projection.permissionToolCall(agent, id, 'scoped-read')).toMatchObject({ kind: 'other' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  expect(projection.permissionToolCall(agent, id, 'scoped-read')).toMatchObject({ kind: 'other', rawInput: '' })
})

it('publishes a committed title on both protocols without a model request', async () => {
  const { eventUpdates } = await import('../src/updates.ts')
  const { eventUpdates: v2Updates } = await import('../src/v2.ts')
  harness = await makeBridgeHarness()
  await harness.client.initialize({ protocolVersion: 1 })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  const session = harness.ctx.agents.get(SessionId(sessionId))!.session
  const event = session.append('session/title', { title: 'ACP review', messageSeqs: [], source: { kind: 'user' } })
  const expected = [{ sessionUpdate: 'session_info_update', title: 'ACP review' }]
  await expect(eventUpdates(harness.ctx, session, event, false)).resolves.toEqual(expected)
  await expect(v2Updates(harness.ctx, session, event)).resolves.toEqual(expected)
  expect(harness.adapter.requests).toHaveLength(0)
})
