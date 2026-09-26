/** Model tools for explicitly routed distributed team operations. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import { commandSchema, type OperationId } from './protocol.ts'
import type { EnvironmentTeams } from './runtime.ts'

/**
 * Install effect-owned tools using the environment's operation owner.
 * @param ctx - Plugin Context owning tool registrations.
 * @param runtime - Local descriptor and authenticated operation dispatcher.
 * @param config - Validated deployment peer and workspace settings.
 */
export function installTools(ctx: Context, runtime: Pick<EnvironmentTeams, 'descriptor' | 'execute'>, config: ResolvedConfig): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'environment_list',
    description: 'List this Harness environment and configured peer environments. A configured peer may be offline. Workspace aliases select separate checkouts on each machine.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() {
      return Promise.resolve(JSON.stringify({
        local: runtime.descriptor(), workspaces: Object.keys(config.workspaces),
        peers: config.peers.map(peer => ({ environmentId: peer.environmentId, url: peer.url, workspaces: peer.workspaces })),
      }))
    },
  })), 'environmentTeam.listTool')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'environment_team',
    description: 'Coordinate agents across Harness environments. list reads your team and revisioned tasks. spawn creates a fresh teammate on an explicit environment/workspace (lead only). send durably queues text to a named member, including lead. task-create adds a task; task-update claims, releases, or completes it using its current revision. interrupt requests a teammate stop (lead only). Queued delivery is not completion. Exchange commits or patches; files are not shared between machines.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'spawn', 'send', 'task-create', 'task-update', 'interrupt'] },
      name: { type: 'string', description: 'Unique lowercase teammate name for spawn.' },
      environmentId: { type: 'string', description: 'Destination UUID from environment_list; required for spawn.' },
      workspace: { type: 'string', description: 'Configured project alias on the destination; required for spawn.' },
      text: { type: 'string', description: 'Self-contained prompt, message, or task description.' },
      target: { type: 'string', description: 'Member name for send or interrupt.' },
      taskId: { type: 'string', description: 'Task identity from list or task-create.' },
      revision: { type: 'integer', description: 'Current task revision for task-update.' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status for task-update.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('environment_team requires an Agent')
      const command = commandSchema.parse(args)
      const operation = brandString<OperationId>(createHash('sha256').update(JSON.stringify([exec.agent.id, exec.callId])).digest('hex'))
      return runtime.execute(exec.agent, operation, command, exec.signal)
    },
  })), 'environmentTeam.commandTool')
}
