/** Session grants repeat exact approved invocations without extending policy or crossing sessions. */
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { makeBridgeHarness } from './harness.ts'

it.each([1, 2] as const)('scopes v%s session grants to exact arguments, directory, reason and policy generation', async (version) => {
  let client: v2.ClientContext | undefined
  let requests = 0
  const offered: string[][] = []
  const harness = await makeBridgeHarness({ ...version === 1 ? {} : { connectClient: (stream) => {
    client = v2.client().onRequest('session/request_permission', ({ params }) => {
      requests++
      offered.push(params.options.map(option => option.kind))
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: 'allow-session' } })
    }).connect(stream).agent
  } } })
  try {
    await harness.ctx.plugin(ApprovalService)
    harness.onPermission = (params) => {
      requests++
      offered.push(params.options.map(option => option.kind))
      return { outcome: { outcome: 'selected', optionId: 'allow-session' } }
    }
    if (client === undefined) await harness.client.initialize({ protocolVersion: 1 })
    else await client.request('initialize', { protocolVersion: 2, info: { name: 'session-grant', version: '1' }, capabilities: {} })
    const create = () => client === undefined
      ? harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      : client.request('session/new', { cwd: process.cwd() })
    const { sessionId } = await create()
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('turn/start', { turn: 1 })
    let ordinal = 0
    const ask = (args = '{"command":"echo approved"}', reason = 'explicit operation') => {
      const callId = ToolCallId(`repeat-${ordinal++}`)
      agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: args })
      return harness.ctx.approval.request({ agent, toolName: 'bash', callId, reason })
    }
    expect(await ask()).toBe('allowed-once')
    expect(offered[0]).toContain('allow_always')
    expect(await ask()).toBe('allowed-once')
    expect(requests).toBe(1)
    expect(await ask('{"command":"echo different"}')).toBe('allowed-once')
    expect(requests).toBe(2)
    expect(await ask(undefined, 'different reason')).toBe('allowed-once')
    expect(requests).toBe(3)
    agent.session.append('working-directory/change', { cwd: `${process.cwd()}/other` })
    expect(await ask()).toBe('allowed-once')
    expect(requests).toBe(4)
    setApprovalPolicy(agent.session, 'ask')
    expect(await ask()).toBe('allowed-once')
    expect(requests).toBe(5)
    setApprovalPolicy(agent.session, 'never')
    expect(await ask()).toBe('rejected')
    expect(requests).toBe(5)
    setApprovalPolicy(agent.session, 'ask')
    expect(await ask()).toBe('allowed-once')
    expect(requests).toBe(6)
    const other = harness.ctx.agents.get(SessionId((await create()).sessionId))!
    other.session.append('turn/start', { turn: 1 })
    const otherCall = ToolCallId('other')
    other.session.append('tool/call', { turn: 1, step: 1, callId: otherCall, name: 'bash', arguments: '{"command":"echo approved"}' })
    expect(await harness.ctx.approval.request({ agent: other, toolName: 'bash', callId: otherCall, reason: 'explicit operation' })).toBe('allowed-once')
    expect(requests).toBe(7)
    expect(await harness.ctx.approval.request({ agent, toolName: 'bash', callId: ToolCallId('unverified') })).toBe('rejected')
    expect(offered.at(-1)).not.toContain('allow_always')
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    other.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } finally { await harness.dispose() }
})

it.each(['policy', 'cancellation'] as const)('does not retain a session grant after %s changes during its decision', async (change) => {
  const harness = await makeBridgeHarness()
  const entered = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<RequestPermissionResponse>()
  const controller = new AbortController()
  try {
    await harness.ctx.plugin(ApprovalService)
    await harness.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('turn/start', { turn: 1 })
    const callId = ToolCallId('pending-grant')
    agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    harness.onPermission = () => { entered.resolve(undefined); return answer.promise }
    const request = harness.ctx.approval.request({ agent, toolName: 'bash', callId, signal: controller.signal })
    await entered.promise
    if (change === 'policy') setApprovalPolicy(agent.session, 'ask')
    else controller.abort(new Error('approval cancelled'))
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'allow-session' } })
    expect(await request).toBe(change === 'policy' ? 'rejected' : 'cancelled')
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    expect(await harness.ctx.approval.request({ agent, toolName: 'bash', callId })).toBe('rejected')
    expect(harness.permissionRequests).toHaveLength(2)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } finally {
    controller.abort()
    answer.resolve({ outcome: { outcome: 'cancelled' } })
    await harness.dispose()
  }
})
