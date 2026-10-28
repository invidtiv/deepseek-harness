/** Live job output through the real loop, registry, and ACP v2 transport. */
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it } from 'vitest'
import { makeBridgeHarness, textResponse } from './harness.ts'

it('streams shell job output before settlement and commits one complete result afterward', async () => {
  let client: v2.ClientContext | undefined
  const updates: v2.SessionUpdate[] = []
  const release = Promise.withResolvers<undefined>()
  const callId = ToolCallId('stream-call')
  const harness = await makeBridgeHarness({
    script: [[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: callId, name: 'stream_shell', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'stream_shell', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], textResponse('done')],
    connectClient: (stream) => {
      client = v2.client().onNotification('session/update', ({ params }) => { updates.push(params.update) }).connect(stream).agent
    },
  })
  try {
    if (client === undefined) throw new Error('missing ACP client')
    await harness.ctx.plugin(Jobs)
    harness.ctx.jobs.attachController('stream-test')
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'stream_shell', description: 'Stream a shell fixture.', parameters: {},
      execute: async (_args, exec) => {
        if (exec.agent === undefined) throw new Error('missing Agent')
        const done = Promise.withResolvers<JobOutcome>()
        let producer: JobHandle | undefined
        const id = harness.ctx.jobs.start({
          kind: 'bash', label: 'fixture', owner: exec.agent.id,
          toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
          run: (handle) => {
            producer = handle
            return { done: done.promise, cancel: () => { release.resolve(undefined); done.resolve({ status: 'killed' }) } }
          },
        })
        if (producer === undefined) throw new Error('missing producer')
        producer.append('early\n')
        await release.promise
        producer.append('late\n')
        done.resolve({ status: 'completed' })
        await harness.ctx.jobs.wait(id, 10_000, exec.agent.id)
        const modelRead = harness.ctx.jobs.read(id, exec.agent.id)
        expect(modelRead.chunks.map(chunk => chunk.text).join('')).toBe('early\nlate\n')
        harness.ctx.jobs.remove(id, exec.agent.id)
        return [{ type: 'text', text: 'early\nlate\n' }]
      },
    }))
    await client.request('initialize', { protocolVersion: 2, info: { name: 'stream', version: '1' }, capabilities: {} })
    const { sessionId } = await client.request('session/new', { cwd: process.cwd() })
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run' }] })
    await expect.poll(() => updates.filter(v2.SessionUpdate.isToolCallContentChunk)).toMatchObject([
      { toolCallId: callId, content: { type: 'content', content: { type: 'text', text: 'early\n' } } },
    ])
    expect(updates.filter(v2.SessionUpdate.isToolCallUpdate).some(update => update.status === 'completed')).toBe(false)
    release.resolve(undefined)
    await expect.poll(() => harness.ctx.agents.get(SessionId(sessionId))?.status).toBe('idle')
    expect(updates.filter(v2.SessionUpdate.isToolCallContentChunk).map(update => update.content)).toEqual([
      { type: 'content', content: { type: 'text', text: 'early\n' } },
      { type: 'content', content: { type: 'text', text: 'late\n' } },
    ])
    expect(updates.filter(v2.SessionUpdate.isToolCallUpdate).find(update => update.status === 'completed')).toMatchObject({
      content: [{ type: 'content', content: { type: 'text', text: 'early\nlate\n' } }],
    })
  } finally {
    release.resolve(undefined)
    await harness.dispose()
  }
})
