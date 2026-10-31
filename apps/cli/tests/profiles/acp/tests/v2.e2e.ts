/** Draft-v2 conformance through the supported ACP profile and real MCP process. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { expect, it } from 'vitest'
import { launchV2Profile } from './v2-harness.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

it('runs model selection, reasoning, MCP tools and replay through v2 stdio', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'))
  const launched = launchV2Profile(cwd, [fileURLToPath(new URL('./fixtures/control-surface/cordis.yml', import.meta.url))], { DSH_CONFORMANCE_PERSISTENCE_ROOT: join(cwd, '.sessions') })
  const { client, updates } = launched
  try {
    expect(await client.request('initialize', { protocolVersion: 2, info: { name: 'profile-test', version: '1' }, capabilities: {} })).toMatchObject({ protocolVersion: 2 })
    const mcpServers: v2.McpServer[] = [{ type: 'stdio', name: 'fixture', command: process.execPath, args: [join(repoRoot, 'packages/mcp/mcp-client/tests/fixture-server.ts')] }]
    const created = await client.request('session/new', { cwd, mcpServers })
    expect(created.availableCommands?.map(command => command.name)).toContain('goal')
    const sessionId = created.sessionId
    const model = created.configOptions?.find(option => option.configId === 'model')
    if (model === undefined || !v2.SessionConfigOption.isSelect(model)) throw new Error('model selector missing')
    const choices = model.options.flatMap(option => 'groupId' in option ? option.options : [option])
    const beta = choices.find(option => option.name === 'Beta')!
    const selected = await client.request('session/set_config_option', { sessionId, configId: 'model', type: 'id', value: beta.value })
    expect(selected.configOptions).toContainEqual(expect.objectContaining({ configId: 'reasoning_effort' }))
    await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', type: 'id', value: 'low' })
    const accepted = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'exercise the attached server' }] })
    expect(accepted).toHaveProperty('messageId')
    await expect.poll(() => updates.at(-1), { timeout: 20_000 }).toMatchObject({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'model=beta; tool=5' } }))
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking the attached tool' } }))
    expect(updates.filter(update => update.sessionUpdate === 'tool_call_update')).toMatchObject([
      { toolCallId: 'control-add', status: 'in_progress' }, { toolCallId: 'control-add', status: 'completed' },
    ])
    expect(updates.some(update => update.sessionUpdate === 'user_message')).toBe(false)
    const messages = updates.filter(update => update.sessionUpdate === 'agent_message_chunk')
    const command = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/goal' }] })
    expect(updates.some(update => update.sessionUpdate === 'user_message')).toBe(false)
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_message_chunk', messageId: `${command.messageId}:result` }))
    await client.request('session/close', { sessionId })
    updates.length = 0
    await client.request('session/resume', { sessionId, cwd, mcpServers, replayFrom: { type: 'start' } })
    expect(updates.filter(update => update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message')).toEqual([
      { sessionUpdate: 'user_message', messageId: accepted.messageId, content: [{ type: 'text', text: 'exercise the attached server' }] },
      ...messages,
    ])
    await client.request('session/close', { sessionId })
    for (const line of launched.stdout().trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0')
  } catch (error: unknown) {
    throw new Error(`v2 profile failed; stderr: ${launched.stderr()}`, { cause: error })
  } finally {
    try { await launched.close() } finally { await rm(cwd, { recursive: true, force: true }) }
  }
}, 45_000)


it('publishes autonomous goal status, permissions and plans and restores progress through v2', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-goal-'))
  let permissions = 0
  const launched = launchV2Profile(cwd, [fileURLToPath(new URL('./fixtures/control-surface/cordis.yml', import.meta.url))],
    { DSH_CONFORMANCE_PERSISTENCE_ROOT: join(cwd, '.sessions') }, async () => {
      permissions++
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
  const { client, updates } = launched
  try {
    await client.request('initialize', { protocolVersion: 2, info: { name: 'goal-test', version: '1' }, capabilities: {} })
    const { sessionId } = await client.request('session/new', { cwd })
    const command = (text: string) => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    await command('/goal finish the task')
    await expect.poll(() => permissions, { timeout: 20_000 }).toBe(1)
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'plan_update', plan: {
      type: 'items', planId: 'todos', entries: [{ content: 'Finish the goal', status: 'in_progress', priority: 'medium' }],
    } }))
    await command('/goal pause')
    await command('/goal resume')
    await expect.poll(() => permissions, { timeout: 20_000 }).toBe(2)
    await client.notify('session/cancel', { sessionId })
    await expect.poll(() => updates.filter(update => update.sessionUpdate === 'state_update').at(-1), { timeout: 20_000 })
      .toMatchObject({ state: 'idle', stopReason: 'cancelled' })
    await client.request('session/close', { sessionId })
    const finalGoal = updates.findLast(update => v2.SessionUpdate.isAgentMessageChunk(update)
      && v2.ContentBlock.isText(update.content) && update.content.text.startsWith('Goal paused (disarmed):'))
    expect(finalGoal).toBeDefined()
    updates.length = 0
    await client.request('session/resume', { sessionId, cwd })
    if (finalGoal === undefined || !v2.SessionUpdate.isAgentMessageChunk(finalGoal)) throw new Error('missing final goal status')
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: finalGoal.content }))
    expect(updates.some(update => update.sessionUpdate === 'plan_update')).toBe(true)
    expect(permissions).toBe(2)
    await client.request('session/close', { sessionId })
  } catch (error: unknown) {
    throw new Error(`v2 goals failed; stderr: ${launched.stderr()}`, { cause: error })
  } finally {
    try { await launched.close() } finally { await rm(cwd, { recursive: true, force: true }) }
  }
})
