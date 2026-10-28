/** Slash commands through both ACP protocols, using the real goal domain and loop. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Stream } from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import Commands from '@deepseek-ai/dsh-commands'
import Goals from '@deepseek-ai/dsh-goal'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'
import * as goalDriver from '@deepseek-ai/dsh-goal-round-driver'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe.each([1, 2] as const)('ACP v%s commands', (version) => {
  let harness: BridgeHarness
  let client: v2.ClientContext | undefined
  let updates: v2.UpdateSessionNotification[]
  afterEach(async () => { await harness?.dispose() })

  function resetClient(): void { client = undefined }

  async function setup(script: NonNullable<Parameters<typeof makeBridgeHarness>[0]>['script'] = []) {
    updates = []
    resetClient()
    harness = await makeBridgeHarness({
      script,
      config: { protocolV2: version === 2 },
      ...version === 1 ? {} : { connectClient: (stream: Stream) => {
        client = v2.client().onNotification('session/update', ({ params }) => { updates.push(params) }).connect(stream).agent
      } },
    })
    await harness.ctx.plugin(Commands)
    await harness.ctx.plugin(Goals, { defaultMaxGoalRounds: 2 })
    await harness.ctx.plugin(commandGoal)
    if (client !== undefined) {
      await client.request('initialize', { protocolVersion: 2, info: { name: 'commands', version: '1' }, capabilities: {} })
      return client.request('session/new', { cwd: process.cwd() })
    }
    await harness.client.initialize({ protocolVersion: 1 })
    return harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  }

  function prompt(sessionId: string, text: string) {
    const params = { sessionId, prompt: [{ type: 'text' as const, text }] }
    return client === undefined ? harness.client.prompt(params) : client.request('session/prompt', params)
  }

  function agent(sessionId: string) {
    const found = harness.ctx.agents.get(SessionId(sessionId))
    if (found === undefined) throw new Error('missing test Agent')
    return found
  }

  function output() {
    return client === undefined
      ? harness.updates.flatMap(update => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])
      : updates.flatMap(({ update }) => v2.SessionUpdate.isAgentMessageChunk(update)
        && v2.ContentBlock.isText(update.content) ? [update.content.text] : [])
  }

  it('advertises commands and executes goal controls without a model request', async () => {
    const created = await setup()
    if (version === 2) {
      expect(created).toMatchObject({ availableCommands: [{ name: 'goal', input: { type: 'text' } }] })
      await expect.poll(() => updates.some(({ update }) => update.sessionUpdate === 'available_commands_update')).toBe(true)
    } else {
      // V1 discovery follows the session/new response that names the session.
      expect(harness.updates).toEqual([])
      await expect.poll(() => harness.updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'available_commands_update' }))
    }
    const { sessionId } = created
    for (const line of ['/goal', '/goal finish the task', '/goal edit finish the revised task', '/goal pause', '/goal resume', '/goal clear']) {
      const result = await prompt(sessionId, line)
      if ('messageId' in result) expect(updates.some(({ update }) => update.sessionUpdate === 'user_message')).toBe(false)
      else expect(result).toEqual({ stopReason: 'end_turn' })
    }
    expect(output().join('\n')).toContain('Goal paused')
    expect(output().at(-1)).toBe('Goal cleared.')
    expect(harness.adapter.requests).toEqual([])
    const events = agent(sessionId).session.snapshotEvents()
    expect(events.filter(event => event.type === 'command/run')).toHaveLength(6)
    expect(events.filter(event => event.type === 'command/done')).toHaveLength(6)
    expect(events.filter(event => event.type === 'user/message')).toEqual([])
  })

  it('reports domain rejection directly and preserves the goal', async () => {
    const { sessionId } = await setup()
    await prompt(sessionId, '/goal original')
    await prompt(sessionId, '/goal replacement')
    expect(output().at(-1)).toContain('A goal is already active')
    expect(harness.ctx.goals.get(agent(sessionId))?.objective).toBe('original')
    expect(harness.adapter.requests).toEqual([])
  })

  it('rejects attachments before executing a command', async () => {
    const { sessionId } = await setup()
    const params = { sessionId, prompt: [{ type: 'text' as const, text: '/goal invalid' }, { type: 'image' as const, mimeType: 'image/png', data: 'AQ==' }] }
    await expect(client === undefined ? harness.client.prompt(params) : client.request('session/prompt', params)).rejects.toThrow('ACP commands accept text only')
    expect(harness.ctx.goals.get(agent(sessionId))).toBeUndefined()
    expect(harness.attachments?.saved).toEqual([])
  })

  it('keeps unknown slash commands as ordinary model input', async () => {
    const { sessionId } = await setup([textResponse('ordinary')])
    await prompt(sessionId, '/unknown text')
    await expect.poll(() => output()).toContain('ordinary')
    const users = agent(sessionId).session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(users.map(event => event.data.content)).toEqual([[{ type: 'text', text: '/unknown text' }]])
  })

  it('runs automatic rounds and accepts pause while the model is busy', async () => {
    const { sessionId } = await setup([textResponse('first round'), 'hang'])
    await harness.ctx.plugin(goalDriver)
    await prompt(sessionId, '/goal finish this task')
    await expect.poll(() => harness.adapter.requests.length).toBe(2)
    await prompt(sessionId, '/goal pause')
    await agent(sessionId).whenIdle()
    expect(harness.ctx.goals.get(agent(sessionId))).toMatchObject({ phase: 'paused', roundsStarted: 2 })
    expect(output().join('\n')).toContain('first round')
    if (client !== undefined) {
      expect(updates).toContainEqual({ sessionId, update: { sessionUpdate: 'state_update', state: 'running' } })
      await expect.poll(() => updates.filter(({ update }) => update.sessionUpdate === 'state_update').at(-1)?.update).toMatchObject({ sessionUpdate: 'state_update', state: 'idle' })
    }
  })

  it('cancels autonomous goal work through session/cancel', async () => {
    const { sessionId } = await setup(['hang'])
    await harness.ctx.plugin(goalDriver)
    await prompt(sessionId, '/goal keep working')
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    if (client === undefined) await harness.client.cancel({ sessionId })
    else await client.notify('session/cancel', { sessionId })
    await expect.poll(() => harness.ctx.goals.get(agent(sessionId))?.phase).toBe('paused')
    await agent(sessionId).whenIdle()
    if (client !== undefined) await expect.poll(() => updates.filter(({ update }) => update.sessionUpdate === 'state_update').at(-1)?.update).toMatchObject({ state: 'idle', stopReason: 'cancelled' })
  })

  it('allows controls during a foreground prompt and preserves its completion', async () => {
    const { sessionId } = await setup(['hang'])
    const work = prompt(sessionId, 'ordinary work')
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    await prompt(sessionId, '/goal')
    expect(output().at(-1)).toContain('No goal is currently set')
    if (client === undefined) await harness.client.cancel({ sessionId })
    else await client.notify('session/cancel', { sessionId })
    await work
    await agent(sessionId).whenIdle()
  })

  it('restores goal state and command discovery after close and resume', async () => {
    const { sessionId } = await setup()
    await prompt(sessionId, '/goal persisted objective')
    if (client === undefined) {
      await harness.client.closeSession({ sessionId })
      await harness.client.resumeSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    } else {
      await client.request('session/close', { sessionId })
      expect(await client.request('session/resume', { sessionId, cwd: process.cwd() })).toMatchObject({ availableCommands: [{ name: 'goal' }] })
    }
    await prompt(sessionId, '/goal')
    expect(output().at(-1)).toContain('persisted objective')
    expect(harness.adapter.requests).toEqual([])
  })

  it('drains an aborted command before closing the Agent', async () => {
    const { sessionId } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    harness.ctx.commands.register({ name: 'wait', description: 'Wait for cancellation', handler: ({ signal }) => {
      entered.resolve(undefined)
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => { stopped.resolve(undefined); resolve({ kind: 'error', text: 'cancelled' }) }, { once: true })
      })
    } })
    const work = prompt(sessionId, '/wait').catch((error: unknown) => error)
    await entered.promise
    await expect(prompt(sessionId, '/goal')).rejects.toThrow('a command is already in flight')
    await expect(prompt(sessionId, 'ordinary text')).rejects.toThrow('a command is already in flight')
    const closing = client === undefined ? harness.client.closeSession({ sessionId }) : client.request('session/close', { sessionId })
    await stopped.promise
    // A registry change during teardown publishes nothing behind the closing record.
    harness.ctx.commands.register({ name: 'late', description: 'Registered during close', handler: () => ({ kind: 'success', text: 'late' }) })()
    await closing
    // The cancelled command settles like a cancelled prompt on each protocol.
    if (client === undefined) expect(await work).toEqual({ stopReason: 'cancelled' })
    else expect(await work).toBeInstanceOf(Error)
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('cancels a running command through session/cancel and keeps the session usable', async () => {
    const { sessionId } = await setup()
    const entered = Promise.withResolvers<undefined>()
    harness.ctx.commands.register({ name: 'wait', description: 'Wait for cancellation', handler: ({ signal }) => {
      entered.resolve(undefined)
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve({ kind: 'error', text: 'stopped' }) }, { once: true })
      })
    } })
    const work = prompt(sessionId, '/wait')
    await entered.promise
    if (client === undefined) await harness.client.cancel({ sessionId })
    else await client.notify('session/cancel', { sessionId })
    if (client === undefined) await expect(work).resolves.toEqual({ stopReason: 'cancelled' })
    else await expect(work).rejects.toThrow('command cancelled before completion')
    expect(output()).toEqual([])
    await prompt(sessionId, '/goal')
    expect(output().at(-1)).toContain('No goal is currently set')
    expect(harness.adapter.requests).toEqual([])
  })

  it('delivers an empty result and reports a command withdrawn before execution', async () => {
    const { sessionId } = await setup()
    harness.ctx.commands.register({ name: 'silent', description: 'No output', handler: () => ({ kind: 'success' }) })
    await prompt(sessionId, '/silent')
    expect(output().at(-1)).toBe('')
    const registry = harness.ctx.get('commands')
    if (registry === undefined) throw new Error('missing command registry')
    const execute = vi.spyOn(registry, 'execute').mockResolvedValueOnce(undefined)
    try {
      await expect(prompt(sessionId, '/silent')).rejects.toThrow('command is no longer available: /silent')
      execute.mockRejectedValueOnce(new Error('registry failed'))
      await expect(prompt(sessionId, '/silent')).rejects.toThrow()
    } finally { execute.mockRestore() }
    await prompt(sessionId, '/silent')
    expect(output()).toEqual(['', ''])
  })

  it('reports status only for goal changes a command did not make itself', async () => {
    const { sessionId } = await setup()
    await prompt(sessionId, '/goal finish the task')
    await prompt(sessionId, '/goal pause')
    const results = output()
    expect(results.filter(text => text.startsWith('Goal active (') || text.startsWith('Goal paused ('))).toEqual([])
    expect(results.at(-1)).toContain('Goal paused')
    const found = agent(sessionId)
    const paused = harness.ctx.goals.get(found)
    if (paused === undefined) throw new Error('missing goal')
    harness.ctx.goals.resume(found, paused)
    await expect.poll(() => output().at(-1)).toContain('Goal active (')
  })

  it('updates discovery when a command is registered and disposed', async () => {
    const { sessionId } = await setup()
    const dispose = harness.ctx.commands.register({ name: 'extra', description: 'Extra command', handler: () => ({ kind: 'success', text: 'extra result' }) })
    await prompt(sessionId, '/extra')
    expect(output().at(-1)).toBe('extra result')
    dispose()
    await expect.poll(() => client === undefined
      ? harness.updates.filter(update => update.sessionUpdate === 'available_commands_update').at(-1)
      : updates.map(item => item.update).filter(v2.SessionUpdate.isAvailableCommandsUpdate).at(-1),
    ).toMatchObject({ availableCommands: [{ name: 'goal' }] })
  })
})
