/** Deterministic standing plan for the ACP progress snapshot. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tool-todo'

export const name = 'acp-progress-fixture'
export const inject = ['commands']

/** Register a direct command that records the plan independently of a model. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'fixture-plan', description: 'Record the fixture task list.',
    handler: ({ agent }) => {
      agent.session.append('todo/write', { todos: [{ content: 'Implement ACP progress', status: 'in_progress' }] })
      return { kind: 'success', text: 'Plan recorded.' }
    },
  })
}
