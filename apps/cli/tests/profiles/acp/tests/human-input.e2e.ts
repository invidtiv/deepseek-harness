/** Human choices cross the real ACP process and remain in durable tool history. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, type CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { launchAcpTestAgent, type AgentUnderTest, type LaunchedAcpTestAgent } from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const agent: AgentUnderTest = {
  binScript: join(repoRoot, 'apps/cli/src/bin.ts'), libBinScript: join(repoRoot, 'apps/cli/lib/bin.js'),
  configPath: fileURLToPath(new URL('./fixtures/human-input/cordis.yml', import.meta.url)),
  profile: 'acp', tsconfigPath: join(repoRoot, 'tsconfig.json'),
}

it('accepts a multi-select human answer and replays the committed result without asking again', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-human-'))
  const requests: CreateElicitationRequest[] = []
  const env = { DSH_CONFORMANCE_PERSISTENCE_ROOT: join(cwd, '.sessions'), DSH_TELEMETRY_DISABLED: '1' }
  let launched: LaunchedAcpTestAgent | undefined
  try {
    launched = launchAcpTestAgent({ agent, cwd, env, createElicitation: async (params) => {
      requests.push(params)
      return { action: 'accept', content: { q0: 'Unit tests\nBuild\nInclude lint' } }
    } })
    await launched.spawned
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {} } } })
    const { sessionId } = await launched.client.newSession({ cwd, mcpServers: [] })
    await expect(launched.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Ask which checks to run' }] })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ mode: 'form', sessionId, message: 'Which checks?', requestedSchema: { properties: { q0: { type: 'string' } } } })
    const expected = JSON.stringify({ answers: [{ id: 'tasks', selected: ['Unit tests', 'Build'], custom: 'Include lint' }] })
    const result = launched.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'human-choice')
    expect(result).toMatchObject({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: expected } }] })
    expect(launched.updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: expected } }))
    await launched.client.closeSession({ sessionId })
    await launched.close()
    launched = launchAcpTestAgent({ agent, cwd, env, createElicitation: async (params) => { requests.push(params); return { action: 'cancel' } } })
    await launched.spawned
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {} } } })
    await launched.client.loadSession({ sessionId, cwd, mcpServers: [] })
    expect(launched.updates).toContainEqual(result)
    expect(requests).toHaveLength(1)
  } finally {
    await launched?.close()
    await rm(cwd, { recursive: true, force: true })
  }
}, 30_000)
