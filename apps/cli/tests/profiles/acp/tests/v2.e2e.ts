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
    const sessionId = created.sessionId
    const model = created.configOptions?.find(option => option.configId === 'model')
    if (model === undefined || !v2.SessionConfigOption.isSelect(model)) throw new Error('model selector missing')
    const choices = model.options.flatMap(option => 'groupId' in option ? option.options : [option])
    const beta = choices.find(option => option.name === 'Beta')!
    const selected = await client.request('session/set_config_option', { sessionId, configId: 'model', type: 'id', value: beta.value })
    expect(selected.configOptions).toContainEqual(expect.objectContaining({ configId: 'reasoning_effort' }))
    await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', type: 'id', value: 'low' })
    expect(await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'exercise the attached server' }] })).toHaveProperty('messageId')
    await expect.poll(() => updates.at(-1), { timeout: 20_000 }).toMatchObject({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_message', content: [{ type: 'text', text: 'model=beta; tool=5' }] }))
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_thought', content: [{ type: 'text', text: 'checking the attached tool' }] }))
    expect(updates.filter(update => update.sessionUpdate === 'tool_call_update')).toMatchObject([
      { toolCallId: 'control-add', status: 'in_progress' }, { toolCallId: 'control-add', status: 'completed' },
    ])
    const messages = updates.filter(update => update.sessionUpdate === 'agent_message' || update.sessionUpdate === 'user_message')
    await client.request('session/close', { sessionId })
    updates.length = 0
    await client.request('session/resume', { sessionId, cwd, mcpServers, replayFrom: { type: 'start' } })
    expect(updates.filter(update => update.sessionUpdate === 'agent_message' || update.sessionUpdate === 'user_message')).toEqual(messages)
    await client.request('session/close', { sessionId })
    for (const line of launched.stdout().trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0')
  } catch (error: unknown) {
    throw new Error(`v2 profile failed; stderr: ${launched.stderr()}`, { cause: error })
  } finally {
    try { await launched.close() } finally { await rm(cwd, { recursive: true, force: true }) }
  }
}, 45_000)
