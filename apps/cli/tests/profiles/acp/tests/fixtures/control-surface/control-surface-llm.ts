/** Keyless two-model adapter for the generic ACP control-surface conformance test. */

import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** Adapter whose deterministic tool turn proves model selection and MCP attachment. */
class ControlSurfaceAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    if (provider !== 'control-fixture') throw new Error(`unknown fixture provider: ${provider}`)
    return { id: provider, name: 'Control fixture' }
  }

  override listModels(provider: string) {
    if (provider !== 'control-fixture') return Promise.resolve([])
    return Promise.resolve([
      { provider, id: 'alpha', name: 'Alpha', inputModalities: ['text'] as const },
      { provider, id: 'beta', name: 'Beta', inputModalities: ['text'] as const },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 2_048 },
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const latest = options.messages.findLast(message => message.role === 'user')
    if (latest?.source?.kind === 'goal') {
      const after = options.messages.slice(options.messages.indexOf(latest))
      if (!after.some(message => message.role === 'tool')) {
        const callId = ToolCallId(`goal-probe-${latest.source.round}`)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: 'acp_goal_probe', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'acp_goal_probe', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) { reject(new Error('cancelled')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      })
      return
    }
    const lastUserIndex = options.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
    const current = options.messages.slice(lastUserIndex)
    const userText = current.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('')
    const hasToolResult = current.some(message => message.role === 'tool')
    if (userText === 'report the interoperability failure') throw new Error('Interop fixture failure')
    if (!hasToolResult) {
      const callId = ToolCallId(userText.includes('cancel') ? 'control-cancel-add' : 'control-add')
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'checking the attached tool' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'checking the attached tool' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: callId,
        name: 'mcp__fixture__add',
        argumentsDelta: '{"a":2,"b":3}',
      }
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: callId,
          name: 'mcp__fixture__add',
          arguments: '{"a":2,"b":3}',
        },
      }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (userText.includes('cancel')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'waiting' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('cancelled'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      })
      return
    }
    const text = `model=${options.model}; tool=5`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'control-surface-llm'
export const inject = ['llm', 'tools', 'approval']

/** Register the deterministic control-surface provider. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['control-fixture'], new ControlSurfaceAdapter())
  ctx.tools.register(defineContentToolFixture({
    name: 'acp_goal_probe', description: 'Wait for client approval during a goal round.', parameters: {},
    execute: async (_args, exec) => {
      if (exec.agent === undefined) throw new Error('goal probe requires an agent')
      exec.agent.session.append('todo/write', { todos: [{ content: 'Finish the goal', status: 'in_progress' }] })
      const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: 'acp_goal_probe', signal: exec.signal })
      return [{ type: 'text', text: `goal permission: ${outcome}` }]
    },
  }))
}
