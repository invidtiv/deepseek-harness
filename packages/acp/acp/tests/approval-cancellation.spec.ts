/** Cancelled approvals release ACP session ownership even when the peer never replies. */
import * as v1 from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { makeBridgeHarness } from './harness.ts'

it.each([1, 2] as const)('releases a cancelled v%s approval before an unresponsive peer sends a late grant', async (version) => {
  const entered = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<v1.RequestPermissionResponse>()
  const control = new AbortController()
  let idle = false
  let initialize!: () => Promise<unknown>
  let create!: () => Promise<{ sessionId: string }>
  let prompt!: (sessionId: string) => Promise<unknown>
  let cancel!: (sessionId: string) => Promise<void>
  let fork!: (sessionId: string) => Promise<{ sessionId: string }>
  const harness = await makeBridgeHarness({ script: ['hang'], connectClient: (stream) => {
    const permission = () => { entered.resolve(undefined); return answer.promise }
    if (version === 1) {
      const client = v1.client({ name: 'approval-cancel-test' }).onRequest(v1.methods.client.session.requestPermission, permission).connect(stream).agent
      initialize = () => client.request(v1.methods.agent.initialize, { protocolVersion: 1 })
      create = () => client.request(v1.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })
      prompt = sessionId => client.request(v1.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'wait' }] })
      cancel = sessionId => client.notify(v1.methods.agent.session.cancel, { sessionId })
      fork = sessionId => client.request(v1.methods.agent.session.fork, { sessionId, cwd: process.cwd(), mcpServers: [] })
    } else {
      const client = v2.client().onRequest('session/request_permission', permission)
        .onNotification('session/update', ({ params }) => { if (params.update.sessionUpdate === 'state_update' && params.update.state === 'idle') idle = true }).connect(stream).agent
      initialize = () => client.request('initialize', { protocolVersion: 2, info: { name: 'approval-cancel-test', version: '1' }, capabilities: {} })
      create = () => client.request('session/new', { cwd: process.cwd() })
      prompt = sessionId => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'wait' }] })
      cancel = sessionId => client.notify('session/cancel', { sessionId })
      fork = sessionId => client.request('session/fork', { sessionId, cwd: process.cwd() })
    }
  } })
  try {
    await harness.ctx.plugin(ApprovalService)
    await initialize()
    const { sessionId } = await create()
    const running = prompt(sessionId)
    await expect.poll(() => harness.adapter.requests.length).toBe(1)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const request = harness.ctx.approval.request({ agent, toolName: 'bash', callId: ToolCallId('cancel-call'), signal: control.signal })
    await entered.promise
    control.abort(new Error('test cancelled approval'))
    await expect(request).resolves.toBe('cancelled')
    await cancel(sessionId)
    await running
    await agent.whenIdle()
    if (version === 2) await expect.poll(() => idle).toBe(true)
    const child = await fork(sessionId)
    expect(child.sessionId).not.toBe(sessionId)
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'allow-session' } })
    await expect(request).resolves.toBe('cancelled')
  } finally {
    control.abort()
    answer.resolve({ outcome: { outcome: 'cancelled' } })
    await harness.dispose()
  }
})
