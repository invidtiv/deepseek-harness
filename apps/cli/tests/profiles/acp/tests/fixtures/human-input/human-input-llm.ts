/** Keyless model exercising the shipped human-question tool. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class HumanInputAdapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'Human input fixture' } }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'fixture', name: 'Fixture', inputModalities: ['text'] as const }]) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result === undefined) {
      const id = ToolCallId('human-choice')
      const args = JSON.stringify({ questions: [{ id: 'tasks', question: 'Which checks?', options: [{ label: 'Unit tests' }, { label: 'Build' }], multi_select: true }] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'ask_user_question', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'ask_user_question', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const name = 'human-input-fixture'
export const inject = ['llm']
/** Install the deterministic model used by the human-input scenario. */
export function apply(ctx: Context): void { ctx.llm.registerAdapter(['human-input-fixture'], new HumanInputAdapter()) }
