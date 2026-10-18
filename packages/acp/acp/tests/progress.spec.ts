/** History loading and progress updates over the real ACP wire and durable store. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Goals from '@deepseek-ai/dsh-goal'
import * as todo from '@deepseek-ai/dsh-tool-todo'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

let harness: BridgeHarness

afterEach(async () => { await harness?.dispose() })

it('loads paged v1 history with stable message ids before continuing the session', async () => {
  harness = await makeBridgeHarness({ script: [textResponse('first answer'), textResponse('second answer')], config: { sessionReplayPageSize: 1 } })
  await harness.client.initialize({ protocolVersion: 1 })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'first question' }] })
  const original = harness.updates.find(update => update.sessionUpdate === 'agent_message_chunk')
  await harness.client.closeSession({ sessionId })
  harness.updates.length = 0
  await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
  expect(harness.updates).toContainEqual(original)
  expect(harness.updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first question' } }))
  expect(harness.adapter.requests).toHaveLength(1)
  await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second question' }] })
  expect(harness.adapter.requests).toHaveLength(2)
  await expect(harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })).rejects.toThrow('already active')
})

it('rolls back a failed v1 replay and leaves the persisted session resumable', async () => {
  harness = await makeBridgeHarness({ script: [textResponse('answer')] })
  await harness.client.initialize({ protocolVersion: 1 })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'question' }] })
  await harness.client.closeSession({ sessionId })
  const open = harness.ctx.sessionPersistence.open.bind(harness.ctx.sessionPersistence)
  const spy = vi.spyOn(harness.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    if (args[1] === 'read') throw new Error('replay unavailable')
    return open(...args)
  })
  try {
    await expect(harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })).rejects.toThrow()
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  } finally { spy.mockRestore() }
  await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
})

describe.each([1, 2] as const)('ACP v%s progress', (version) => {
  it('publishes goal changes and task plans, restores them on resume and clears the plan on the next turn', async () => {
    const updates: v2.UpdateSessionNotification[] = []
    let client: v2.ClientContext | undefined
    harness = await makeBridgeHarness({
      script: [probeCall(), textResponse('done')], config: { experimentalV2: version === 2 },
      ...version === 1 ? {} : { connectClient: (stream) => {
        client = v2.client().onNotification('session/update', ({ params }) => { updates.push(params) }).connect(stream).agent
      } },
    })
    await harness.ctx.plugin(Goals, { defaultMaxGoalRounds: 3 })
    await harness.ctx.plugin(todo, { allowParallelInProgress: true })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'Read the fixture value.', parameters: {},
      execute: async () => [{ type: 'text', text: 'fixture value' }],
    }))
    if (client === undefined) await harness.client.initialize({ protocolVersion: 1 })
    else await client.request('initialize', { protocolVersion: 2, info: { name: 'progress', version: '1' }, capabilities: {} })
    const { sessionId } = client === undefined
      ? await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      : await client.request('session/new', { cwd: process.cwd() })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const ref = harness.ctx.goals.create(agent, { objective: 'ship the task' })
    harness.ctx.goals.pause(agent, ref)
    agent.session.append('todo/write', { todos: [{ content: 'Implement', status: 'in_progress' }] })
    const texts = () => version === 1
      ? harness.updates.flatMap(update => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])
      : updates.flatMap(({ update }) => v2.SessionUpdate.isAgentMessage(update)
        ? (update.content ?? []).flatMap(block => v2.ContentBlock.isText(block) ? [block.text] : []) : [])
    const plans = () => version === 1
      ? harness.updates.flatMap(update => update.sessionUpdate === 'plan' ? [update.entries] : [])
      : updates.flatMap(({ update }) => v2.SessionUpdate.isPlanUpdate(update) && v2.PlanUpdateContent.isItems(update.plan)
        ? [update.plan.entries] : [])
    await expect.poll(() => texts().join('\n')).toContain('Goal paused')
    await expect.poll(plans).toContainEqual([{ content: 'Implement', status: 'in_progress', priority: 'medium' }])
    if (client === undefined) await harness.client.closeSession({ sessionId })
    else await client.request('session/close', { sessionId })
    harness.updates.length = 0; updates.length = 0
    if (client === undefined) await harness.client.resumeSession({ sessionId, cwd: process.cwd() })
    else await client.request('session/resume', { sessionId, cwd: process.cwd() })
    expect(texts().join('\n')).toContain('Goal paused (disarmed): ship the task')
    expect(plans()).toEqual([[{ content: 'Implement', status: 'in_progress', priority: 'medium' }]])
    const prompt = { sessionId, prompt: [{ type: 'text' as const, text: 'continue' }] }
    if (client === undefined) await harness.client.prompt(prompt)
    else await client.request('session/prompt', prompt)
    await expect.poll(() => plans().at(-1)).toEqual([])
    if (client === undefined) await harness.client.closeSession({ sessionId })
    else await client.request('session/close', { sessionId })
    harness.updates.length = 0; updates.length = 0
    if (client === undefined) await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    else await client.request('session/resume', { sessionId, cwd: process.cwd(), replayFrom: { type: 'start' } })
    expect(plans()).toEqual([[{ content: 'Implement', status: 'in_progress', priority: 'medium' }], []])
    const replayed = version === 1 ? harness.updates : updates.map(item => item.update)
    expect(replayed).toContainEqual(expect.objectContaining({ toolCallId: 'progress-probe', status: 'completed' }))
  })
})


it('reports goal block reasons, completion and clearing without model input', async () => {
  harness = await makeBridgeHarness()
  await harness.ctx.plugin(Goals)
  await harness.client.initialize({ protocolVersion: 1 })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  const agent = harness.ctx.agents.get(SessionId(sessionId))!
  const goal = harness.ctx.goals.create(agent, { objective: 'finish' })
  const blocked = harness.ctx.goals.block(agent, goal, { code: 'missing-input', message: 'Need the target path.' })
  const completed = harness.ctx.goals.complete(agent, blocked)
  harness.ctx.goals.clear(agent, completed)
  await expect.poll(() => harness.updates.flatMap(update => update.sessionUpdate === 'agent_message_chunk'
    && update.content.type === 'text' ? [update.content.text] : []).join('\n')).toContain('Goal cleared.')
  const text = JSON.stringify(harness.updates)
  expect(text).toContain('Goal blocked (disarmed): finish')
  expect(text).toContain('Blocked: Need the target path.')
  expect(text).toContain('Goal complete (disarmed): finish')
  expect(harness.adapter.requests).toEqual([])
})

it('rejects prompt admission until v1 history loading finishes', async () => {
  harness = await makeBridgeHarness({ script: [textResponse('answer')] })
  await harness.client.initialize({ protocolVersion: 1 })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'question' }] })
  await harness.client.closeSession({ sessionId })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const open = harness.ctx.sessionPersistence.open.bind(harness.ctx.sessionPersistence)
  const spy = vi.spyOn(harness.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const reader = await open(...args)
    if (args[1] === 'read') {
      const read = reader.read.bind(reader)
      vi.spyOn(reader, 'read').mockImplementation(async (...readArgs) => {
        entered.resolve(undefined)
        await release.promise
        return read(...readArgs)
      })
    }
    return reader
  })
  const loading = harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
  try {
    await entered.promise
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'too soon' }] })).rejects.toThrow('activating')
  } finally {
    release.resolve(undefined)
    await loading
    spy.mockRestore()
  }
  expect(harness.adapter.requests).toHaveLength(1)
})


it('refuses incomplete persisted history and releases the activated session', async () => {
  harness = await makeBridgeHarness({ script: [textResponse('answer')] })
  await harness.client.initialize({ protocolVersion: 1 })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'question' }] })
  await harness.client.closeSession({ sessionId })
  const open = harness.ctx.sessionPersistence.open.bind(harness.ctx.sessionPersistence)
  const spy = vi.spyOn(harness.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const reader = await open(...args)
    if (args[1] === 'read') {
      const read = reader.read.bind(reader)
      vi.spyOn(reader, 'read').mockImplementation(async (...readArgs) => ({ ...await read(...readArgs), events: [] }))
    }
    return reader
  })
  try {
    await expect(harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow('session replay is missing persisted events')
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  } finally { spy.mockRestore() }
})


/** A real tool round whose committed call and result must survive protocol replay. */
function probeCall(): StreamChunk[] {
  const id = ToolCallId('progress-probe')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'probe', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'probe', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
