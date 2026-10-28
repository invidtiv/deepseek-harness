/** Session configuration, fork isolation, and model-dependent image admission over ACP v2. */
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('ACP session controls', () => {
  let harness: BridgeHarness
  let client: v2.ClientContext
  const updates: v2.UpdateSessionNotification[] = []
  afterEach(async () => { await harness?.dispose() })

  async function setup(options: Parameters<typeof makeBridgeHarness>[0] = {}) {
    updates.length = 0
    harness = await makeBridgeHarness({
      ...options,
      connectClient: (stream) => {
        client = v2.client().onNotification('session/update', ({ params }) => { updates.push(params) }).connect(stream).agent
      },
    })
    return client.request('initialize', { protocolVersion: 2, info: { name: 'controls', version: '1' }, capabilities: {} })
  }

  function agent(id: string) {
    const result = harness.ctx.agents.get(SessionId(id))
    if (result === undefined) throw new Error('missing test Agent')
    return result
  }

  it('selects plan/build using the plan domain and preserves it across a fork', async () => {
    await setup({ script: [textResponse('planned'), textResponse('built')] })
    await harness.ctx.plugin(PlanMode, { section: 'Plan carefully before implementation.' })
    const source = await client.request('session/new', { cwd: process.cwd() })
    expect(source.configOptions).toContainEqual(expect.objectContaining({ configId: 'collaboration_mode', currentValue: 'build' }))
    await expect(client.request('session/set_config_option', {
      sessionId: source.sessionId, type: 'id', configId: 'collaboration_mode', value: 'invalid',
    })).rejects.toThrow(/plan or build/)
    const planned = await client.request('session/set_config_option', {
      sessionId: source.sessionId, type: 'id', configId: 'collaboration_mode', value: 'plan',
    })
    expect(planned.configOptions).toContainEqual(expect.objectContaining({ configId: 'collaboration_mode', currentValue: 'plan' }))
    expect(harness.ctx.planMode.get(agent(source.sessionId))).toEqual({ active: true })
    const child = await client.request('session/fork', { sessionId: source.sessionId, cwd: process.cwd() })
    expect(child.sessionId).not.toBe(source.sessionId)
    expect(child.configOptions).toContainEqual(expect.objectContaining({ configId: 'collaboration_mode', currentValue: 'plan' }))
    await client.request('session/set_config_option', {
      sessionId: child.sessionId, type: 'id', configId: 'collaboration_mode', value: 'build',
    })
    expect(harness.ctx.planMode.get(agent(child.sessionId))).toEqual({ active: false })
    expect(harness.ctx.planMode.get(agent(source.sessionId))).toEqual({ active: true })
    await client.request('session/prompt', { sessionId: source.sessionId, prompt: [{ type: 'text', text: 'design' }] })
    await expect.poll(() => agent(source.sessionId).status).toBe('idle')
    expect(harness.adapter.requests[0]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Plan carefully before implementation.')))).toBe(true)
    await client.request('session/prompt', { sessionId: child.sessionId, prompt: [{ type: 'text', text: 'implement' }] })
    await expect.poll(() => agent(child.sessionId).status).toBe('idle')
    expect(harness.adapter.requests[1]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Plan carefully before implementation.')))).toBe(false)
  })

  it('omits unavailable plan controls and rejects forks while a source is running', async () => {
    await setup({ script: ['hang'] })
    const source = await client.request('session/new', { cwd: process.cwd() })
    expect(source.configOptions?.some(option => option.configId === 'collaboration_mode')).toBe(false)
    await expect(client.request('session/set_config_option', {
      sessionId: source.sessionId, type: 'id', configId: 'collaboration_mode', value: 'plan',
    })).rejects.toThrow(/unavailable/)
    await client.request('session/prompt', { sessionId: source.sessionId, prompt: [{ type: 'text', text: 'wait' }] })
    await expect(client.request('session/fork', { sessionId: source.sessionId, cwd: process.cwd() })).rejects.toThrow(/work in flight/)
    expect(harness.ctx.agents.list()).toHaveLength(1)
  })

  it('admits images after a text-to-vision model change without renegotiating initialize', async () => {
    const initialized = await setup({ imageCapable: true, config: { model: 'plain' }, script: [textResponse('seen')] })
    expect(initialized.capabilities?.session?.prompt?.image).toEqual({})
    const source = await client.request('session/new', { cwd: process.cwd() })
    const prompt = [{ type: 'image' as const, mimeType: 'image/png', data: 'AQ==' }]
    await expect(client.request('session/prompt', { sessionId: source.sessionId, prompt })).rejects.toThrow(/does not declare image input/)
    expect(harness.attachments?.saved).toEqual([])
    await client.request('session/set_config_option', {
      sessionId: source.sessionId, type: 'id', configId: 'model', value: '["mock","mock"]',
    })
    await client.request('session/prompt', { sessionId: source.sessionId, prompt })
    await expect.poll(() => agent(source.sessionId).status).toBe('idle')
    expect(harness.attachments?.saved).toHaveLength(1)
    await client.request('session/set_config_option', {
      sessionId: source.sessionId, type: 'id', configId: 'model', value: '["mock","plain"]',
    })
    await expect(client.request('session/prompt', { sessionId: source.sessionId, prompt })).rejects.toThrow(/does not declare image input/)
    expect(harness.attachments?.saved).toHaveLength(1)
  })
})
