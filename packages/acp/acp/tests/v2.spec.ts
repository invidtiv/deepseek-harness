/** Draft-v2 wire tests over the real Harness loop and durable session store. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import Commands from '@deepseek-ai/dsh-commands'
import Goals from '@deepseek-ai/dsh-goal'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'
import * as goalDriver from '@deepseek-ai/dsh-goal-round-driver'
import { ACP_PACKAGE_VERSION, makeBridgeHarness, textResponse, errorResponse, type BridgeHarness } from './harness.ts'

/** One committed call of a registered tool, so the loop runs its executor. */
function toolCall(name: string): StreamChunk[] {
  const id = ToolCallId(`${name}-call`)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

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
      config: { ...options.config },
      connectClient: (stream) => {
        client = v2.client()
          .onNotification('session/update', ({ params }) => { updates.push(params) })
          .onRequest('session/request_permission', ({ params }) => permission(params))
          .connect(stream).agent
      },
    })
    return client.request('initialize', { protocolVersion: 2, info: { name: 'conformance', version: '1' }, capabilities: {} })
  }

  function lastState(sessionId: string): v2.SessionUpdate | undefined {
    return updates.filter(item => item.sessionId === sessionId && v2.SessionUpdate.isStateUpdate(item.update)).at(-1)?.update
  }

  async function idle(sessionId: string, stopReason: string) {
    await expect.poll(() => lastState(sessionId)).toMatchObject({ sessionUpdate: 'state_update', state: 'idle', stopReason })
  }

  /** The serialized terminal state, whose `_meta.error` carries failure detail. */
  function idleDetail(sessionId: string): string {
    return JSON.stringify(lastState(sessionId))
  }

  it('negotiates v2 by default and retains the v1 handshake', async () => {
    expect(await setup()).toEqual({
      protocolVersion: 2, info: { name: 'deepseek-harness-acp', version: ACP_PACKAGE_VERSION },
      capabilities: { session: { mcp: { stdio: {}, http: {} }, prompt: {} } }, authMethods: [],
    })
    await harness.dispose()
    harness = await makeBridgeHarness({ script: [textResponse('v1')] })
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
    const message = updates.find(item => item.update.sessionUpdate === 'agent_message_chunk')?.update
    expect(message).toMatchObject({ content: { type: 'text', text: 'answer' } })
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
    expect(idleDetail(sessionId)).toContain('"_meta":{"error":"')
    expect(idleDetail(sessionId)).toContain('provider failed')
    expect(updates.some(item => item.update.sessionUpdate === 'agent_message_chunk')).toBe(false)
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

  it('allows an explicit v1-only deployment', async () => {
    harness = await makeBridgeHarness({ config: { protocolV2: false } })
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
    expect(updates.some(item => item.update.sessionUpdate === 'agent_message_chunk')).toBe(true)
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
    expect(updates.filter(({ update }) => update.sessionUpdate === 'state_update').at(-1)?.update).toMatchObject({ state: 'idle', stopReason: 'cancelled' })
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
    expect(updates.filter(({ update }) => update.sessionUpdate === 'state_update').at(-1)?.update).toMatchObject({ state: 'idle', stopReason: 'cancelled' })
  })

  it('withholds activity states for a permission raised after cancellation', async () => {
    await setup({ script: [toolCall('guarded'), 'hang'] })
    await harness.ctx.plugin(ApprovalService)
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('missing Agent')
    const outcomes: string[] = []
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'guarded', description: 'Ask for permission twice.', parameters: {},
      execute: async () => {
        outcomes.push(await harness.ctx.approval.request({ agent, toolName: 'guarded', callId: ToolCallId('guard-1') }))
        outcomes.push(await harness.ctx.approval.request({ agent, toolName: 'guarded', callId: ToolCallId('guard-2') }))
        return [{ type: 'text', text: outcomes.join(',') }]
      },
    }))
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<v2.RequestPermissionResponse>()
    permission = () => { entered.resolve(undefined); return answer.promise }
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await entered.promise
    expect(lastState(sessionId)).toMatchObject({ state: 'requires_action' })
    await client.notify('session/cancel', { sessionId })
    const before = updates.length
    permission = async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    await idle(sessionId, 'cancelled')
    expect(outcomes).toEqual(['rejected', 'allowed-once'])
    const states = updates.slice(before).flatMap(({ update }) => v2.SessionUpdate.isStateUpdate(update) ? [update.state] : [])
    expect(states).toEqual(['idle'])
  })

  it('publishes v2 configuration options when adapter topology changes', async () => {
    await setup()
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    harness.registerCatalogProvider('late')
    const latest = () => updates.filter(item => item.sessionId === sessionId).at(-1)?.update
    await expect.poll(latest).toMatchObject({ sessionUpdate: 'config_option_update' })
    expect(JSON.stringify(latest())).toContain('"configId":"model"')
  })

  it('forwards the permission reason and request signal and maps a cancelled answer', async () => {
    await setup({ script: ['hang'] })
    await harness.ctx.plugin(ApprovalService)
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    const seen: v2.RequestPermissionRequest[] = []
    permission = async (params) => { seen.push(params); return { outcome: { outcome: 'cancelled' } } }
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const controller = new AbortController()
    expect(await harness.ctx.approval.request({
      agent, toolName: 'bash', callId: ToolCallId('call'), reason: 'writes outside the workspace', signal: controller.signal,
    })).toBe('cancelled')
    expect(seen[0]).toMatchObject({ title: 'bash', description: 'writes outside the workspace' })
    await client.notify('session/cancel', { sessionId })
    await idle(sessionId, 'cancelled')
  })

  it('changes configuration through v2 ids and rejects other option types', async () => {
    await setup()
    const { sessionId, configOptions } = await client.request('session/new', { cwd: process.cwd() })
    const model = configOptions?.find(option => option.configId === 'model')
    if (model === undefined || !v2.SessionConfigOption.isSelect(model)) throw new Error('model selector missing')
    const plain = model.options.flatMap(option => 'groupId' in option ? option.options : [option]).find(option => option.name === 'Mock Plain')
    if (plain === undefined) throw new Error('plain model missing')
    const changed = await client.request('session/set_config_option', { sessionId, configId: 'model', type: 'id', value: plain.value })
    expect(changed.configOptions.find(option => option.configId === 'model')).toMatchObject({ currentValue: plain.value })
    await expect(client.request('session/set_config_option', { sessionId, configId: 'model', type: '_future', value: plain.value }))
      .rejects.toThrow('unsupported configuration option type')
  })

  it('rolls back a failed v2 replay and leaves the persisted session resumable', async () => {
    await setup({ script: [textResponse('answer')] })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'question' }] })
    await idle(sessionId, 'end_turn')
    await client.request('session/close', { sessionId })
    const open = harness.ctx.sessionPersistence.open.bind(harness.ctx.sessionPersistence)
    const spy = vi.spyOn(harness.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      if (args[1] === 'read') throw new Error('replay unavailable')
      return open(...args)
    })
    try {
      await expect(client.request('session/resume', { sessionId, cwd: process.cwd(), replayFrom: { type: 'start' } })).rejects.toThrow()
      expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    } finally { spy.mockRestore() }
    await client.request('session/resume', { sessionId, cwd: process.cwd(), replayFrom: { type: 'start' } })
  })

  it('rejects a prompt removed before it commits to the conversation without echoing it', async () => {
    await setup()
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    const dispose = harness.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind === 'user') agent.inbox.remove(message.id)
    })
    try {
      await expect(client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] }))
        .rejects.toThrow('prompt cancelled before insertion')
    } finally { dispose() }
    expect(updates.filter(item => item.sessionId === sessionId)).toEqual([])
  })

  it('accepts a prompt queued behind autonomous work only when its turn commits it', async () => {
    await setup({ script: ['hang'] })
    await harness.ctx.plugin(Commands)
    await harness.ctx.plugin(Goals)
    await harness.ctx.plugin(commandGoal)
    await harness.ctx.plugin(goalDriver)
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/goal finish the task' }] })
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    const queued = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'queued' }] })
    const rejected = expect(queued).rejects.toThrow('prompt cancelled before insertion')
    await expect.poll(() => harness.ctx.agents.get(SessionId(sessionId))?.inbox.nextTurn.length).toBe(1)
    await client.notify('session/cancel', { sessionId })
    await rejected
    const echoed = updates.flatMap(({ update }) => v2.SessionUpdate.isUserMessage(update) ? [update] : [])
    expect(JSON.stringify(echoed)).not.toContain('queued')
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    expect(JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'user/message'))).not.toContain('queued')
  })

  it('reports a missing committed image attachment as a failed turn with its detail', async () => {
    const missing = { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    await setup({ script: [[
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: missing } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'show it' }] })
    await idle(sessionId, 'error')
    expect(idleDetail(sessionId)).toContain('attachment')
    expect(updates.some(item => item.update.sessionUpdate === 'agent_message_chunk')).toBe(false)
  })

  it('contains a failed autonomous update outside any prompt', async () => {
    const missing = { attachmentId: `sha256:${'b'.repeat(64)}` as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    await setup({ script: [[
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: missing } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    await harness.ctx.plugin(Commands)
    await harness.ctx.plugin(Goals, { defaultMaxGoalRounds: 1 })
    await harness.ctx.plugin(commandGoal)
    await harness.ctx.plugin(goalDriver)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/goal show the image' }] })
    await expect.poll(() => warn.mock.calls.some(([message]) => String(message).includes('output conversion failed'))).toBe(true)
    await expect.poll(() => lastState(sessionId)).toMatchObject({ state: 'idle' })
    const images = updates.filter(item => v2.SessionUpdate.isAgentMessageChunk(item.update) && v2.ContentBlock.isImage(item.update.content))
    expect(images).toEqual([])
  })

  it('reports a failed autonomous round through idle with its detail', async () => {
    await setup({ script: [errorResponse('round failed')] })
    await harness.ctx.plugin(Commands)
    await harness.ctx.plugin(Goals)
    await harness.ctx.plugin(commandGoal)
    await harness.ctx.plugin(goalDriver)
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/goal finish the task' }] })
    await idle(sessionId, 'error')
    expect(idleDetail(sessionId)).toContain('round failed')
  })
})
