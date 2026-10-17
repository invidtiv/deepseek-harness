/** Draft-v2 wire tests over the real Harness loop and durable session store. */
import { afterEach, describe, expect, it } from 'vitest'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import Commands from '@deepseek-ai/dsh-commands'
import Goals from '@deepseek-ai/dsh-goal'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'
import * as goalDriver from '@deepseek-ai/dsh-goal-round-driver'
import { makeBridgeHarness, textResponse, errorResponse, type BridgeHarness } from './harness.ts'

describe('negotiated ACP v2', () => {
  let harness: BridgeHarness
  let client: v2.ClientContext
  let updates: v2.UpdateSessionNotification[]
  let permission: (params: v2.RequestPermissionRequest) => Promise<v2.RequestPermissionResponse>

  afterEach(async () => { await harness?.dispose() })

  async function setup(options: Parameters<typeof makeBridgeHarness>[0] = {}) {
    updates = []
    permission = async () => ({ outcome: { outcome: 'cancelled' } })
    harness = await makeBridgeHarness({
      ...options,
      config: { experimentalV2: true, ...options.config },
      connectClient: (stream) => {
        client = v2.client()
          .onNotification('session/update', ({ params }) => { updates.push(params) })
          .onRequest('session/request_permission', ({ params }) => permission(params))
          .connect(stream).agent
      },
    })
    return client.request('initialize', { protocolVersion: 2, info: { name: 'conformance', version: '1' }, capabilities: {} })
  }

  async function idle(sessionId: string, stopReason: string) {
    await expect.poll(() => updates.filter(item => item.sessionId === sessionId).at(-1)?.update).toMatchObject({
      sessionUpdate: 'state_update', state: 'idle', stopReason,
    })
  }

  it('negotiates only advertised baseline capabilities and retains the v1 handshake', async () => {
    expect(await setup()).toEqual({
      protocolVersion: 2, info: { name: 'deepseek-harness', version: '0.2.1-alpha.1' },
      capabilities: { session: { mcp: { stdio: {}, http: {} }, prompt: {} } }, authMethods: [],
    })
    await harness.dispose()
    harness = await makeBridgeHarness({ config: { experimentalV2: true }, script: [textResponse('v1')] })
    expect(await harness.client.initialize({ protocolVersion: 1 })).toMatchObject({ protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp' } })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })).toEqual({ stopReason: 'end_turn' })
  })

  it('acknowledges the durable inbox identity before a blocked model settles and cancels by state', async () => {
    await setup({ script: ['hang'] })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    const { messageId } = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    expect(messageId).toEqual(expect.any(String))
    await expect.poll(() => updates.map(item => item.update.sessionUpdate)).toContain('user_message')
    expect(updates.slice(0, 2).map(item => item.update)).toEqual([
      { sessionUpdate: 'user_message', messageId, content: [{ type: 'text', text: 'hello' }] },
      { sessionUpdate: 'state_update', state: 'running' },
    ])
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    expect(agent.session.snapshotEvents().find(event => event.type === 'user/message')?.data).toMatchObject({ id: messageId })
    await client.notify('session/cancel', { sessionId })
    await idle(sessionId, 'cancelled')
  })

  it('projects committed messages and usage, then lists, closes and replays stable ids', async () => {
    await setup({ script: [textResponse('answer')] })
    const { sessionId, configOptions } = await client.request('session/new', { cwd: process.cwd() })
    expect(configOptions?.[0]).toHaveProperty('configId', 'model')
    const accepted = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'question' }] })
    await idle(sessionId, 'end_turn')
    const message = updates.find(item => item.update.sessionUpdate === 'agent_message')?.update
    expect(message).toMatchObject({ content: [{ type: 'text', text: 'answer' }] })
    expect(message).toHaveProperty('messageId')
    expect(updates.some(item => item.update.sessionUpdate === 'usage_update')).toBe(true)
    await client.request('session/close', { sessionId })
    expect((await client.request('session/list', {})).sessions).toContainEqual(expect.objectContaining({ sessionId }))
    updates = []
    await client.request('session/resume', { sessionId, cwd: process.cwd(), replayFrom: { type: 'start' } })
    expect(updates.map(item => item.update)).toContainEqual(message)
    expect(updates.map(item => item.update)).toContainEqual({ sessionUpdate: 'user_message', messageId: accepted.messageId, content: [{ type: 'text', text: 'question' }] })
    expect(updates.at(-1)?.update).toEqual({ sessionUpdate: 'state_update', state: 'idle' })
  })

  it('reports post-acceptance failures through idle without leaking provider partials', async () => {
    await setup({ script: [errorResponse('provider failed')] })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    expect(await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })).toHaveProperty('messageId')
    await idle(sessionId, 'error')
    expect(updates.some(item => item.update.sessionUpdate === 'agent_message')).toBe(false)
  })

  it('carries permissions as subjects and brackets the request with foreground states', async () => {
    await setup({ script: ['hang'] })
    await harness.ctx.plugin(ApprovalService)
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    permission = async (params) => {
      expect(params).toMatchObject({ title: 'bash', subject: { type: 'tool_call', toolCall: { toolCallId: 'call' } } })
      expect(updates.at(-1)?.update).toEqual({ sessionUpdate: 'state_update', state: 'requires_action' })
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    }
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    expect(await harness.ctx.approval.request({ agent, toolName: 'bash', callId: ToolCallId('call') })).toBe('allowed-once')
    await expect.poll(() => updates.at(-1)?.update).toEqual({ sessionUpdate: 'state_update', state: 'running' })
    await client.notify('session/cancel', { sessionId })
    await idle(sessionId, 'cancelled')
  })

  it('isolates simultaneous sessions and drains them on connection teardown', async () => {
    await setup({ script: ['hang', textResponse('second')] })
    const first = await client.request('session/new', { cwd: process.cwd() })
    const second = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId: first.sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    await client.request('session/prompt', { sessionId: second.sessionId, prompt: [{ type: 'text', text: 'two' }] })
    await idle(second.sessionId, 'end_turn')
    expect(updates.filter(item => item.sessionId === first.sessionId).at(-1)?.update).toMatchObject({ state: 'running' })
    await harness.closeClientTransport()
    await expect.poll(() => harness.ctx.agents.get(SessionId(first.sessionId))).toBeUndefined()
    await expect.poll(() => harness.ctx.agents.get(SessionId(second.sessionId))).toBeUndefined()
  })

  it('rejects unsupported content before insertion and admits images through the existing store', async () => {
    await setup({ script: [textResponse('seen')], imageCapable: true })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await expect(client.request('session/prompt', { sessionId, prompt: [{ type: '_future' }] })).rejects.toThrow('unsupported prompt content')
    expect(updates).toEqual([])
    const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }
    await client.request('session/prompt', { sessionId, prompt: [image] })
    await idle(sessionId, 'end_turn')
    expect(updates[0]?.update).toMatchObject({ sessionUpdate: 'user_message', content: [image] })
  })

  it('leaves v2 disabled by default', async () => {
    harness = await makeBridgeHarness()
    expect(await harness.client.initialize({ protocolVersion: 2 })).toMatchObject({ protocolVersion: 1 })
  })

  it('detaches request cancellation after insertion and rejects a second in-flight prompt', async () => {
    await setup({ script: ['hang'] })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    const controller = new AbortController()
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] }, { cancellationSignal: controller.signal })
    controller.abort()
    await expect(client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })).rejects.toThrow('already in flight')
    expect(updates.some(item => v2.SessionUpdate.isStateUpdate(item.update) && item.update.state === 'idle')).toBe(false)
    await client.request('session/close', { sessionId })
    await idle(sessionId, 'cancelled')
  })

  it('cancels asynchronous image admission without inserting a message', async () => {
    await setup({ imageCapable: true })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = () => { entered.resolve(undefined); return release.promise }
    const pending = client.request('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] })
    const rejected = expect(pending).rejects.toThrow('cancelled before insertion')
    try {
      await entered.promise
      await client.notify('session/cancel', { sessionId })
    } finally {
      release.resolve(undefined)
    }
    await rejected
    expect(updates).toEqual([])
    expect(harness.adapter.requests).toEqual([])
  })

  it('replays pages and rolls back an unsupported cursor without activating the session', async () => {
    await setup({ script: [textResponse('answer')], config: { sessionReplayPageSize: 1 } })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await idle(sessionId, 'end_turn')
    await client.request('session/close', { sessionId })
    await expect(client.request('session/resume', { sessionId, cwd: process.cwd(), replayFrom: { type: '_future' } })).rejects.toThrow('unsupported replay cursor')
    updates = []
    await client.request('session/resume', { sessionId, cwd: process.cwd() })
    expect(updates.map(item => item.update)).toEqual([{ sessionUpdate: 'state_update', state: 'idle' }])
    await client.request('session/close', { sessionId })
    updates = []
    await client.request('session/resume', { sessionId, cwd: process.cwd(), replayFrom: { type: 'start' } })
    expect(updates.some(item => item.update.sessionUpdate === 'agent_message')).toBe(true)
  })

  it('fails closed on unknown permission outcomes and does not revive completed work after a late answer', async () => {
    await setup({ script: ['hang'] })
    await harness.ctx.plugin(ApprovalService)
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<v2.RequestPermissionResponse>()
    permission = () => { entered.resolve(undefined); return answer.promise }
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const request = harness.ctx.approval.request({ agent, toolName: 'bash', callId: ToolCallId('call') })
    try {
      await entered.promise
      await client.notify('session/cancel', { sessionId })
      await idle(sessionId, 'cancelled')
    } finally {
      answer.resolve({ outcome: { outcome: '_future' } })
    }
    expect(await request).toBe('rejected')
    expect(updates.at(-1)?.update).toMatchObject({ state: 'idle', stopReason: 'cancelled' })
  })

  it('reports permission waits during an autonomous goal round without reviving cancelled work', async () => {
    await setup({ script: ['hang'] })
    await harness.ctx.plugin(ApprovalService)
    await harness.ctx.plugin(Commands)
    await harness.ctx.plugin(Goals)
    await harness.ctx.plugin(commandGoal)
    await harness.ctx.plugin(goalDriver)
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/goal finish the task' }] })
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<v2.RequestPermissionResponse>()
    permission = () => { entered.resolve(undefined); return answer.promise }
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const request = harness.ctx.approval.request({ agent, toolName: 'bash', callId: ToolCallId('goal-call') })
    try {
      await entered.promise
      expect(updates.at(-1)?.update).toMatchObject({ state: 'requires_action' })
      await client.notify('session/cancel', { sessionId })
      await idle(sessionId, 'cancelled')
    } finally {
      answer.resolve({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    }
    expect(await request).toBe('rejected')
    expect(updates.at(-1)?.update).toMatchObject({ state: 'idle', stopReason: 'cancelled' })
  })
})
