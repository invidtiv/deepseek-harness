/**
 * Names the SSH execution world a session's workspace lives in, so an agent
 * whose files, processes and sandboxing run on a remote host knows that before
 * it acts. A workspace served by this host contributes nothing.
 * @module @deepseek-ai/dsh-execution-world-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'

/** Plugin name registered with the Loader. */
export const name = 'execution-world-context'

/** Prompt registry this context contributes to; the world sources stay optional. */
export const inject = ['systemPrompt']

/** One workspace fact this context reads from the workspace registry by name. */
interface WorkspaceWorldSource {
  /**
   * Every registered workspace, in registry order.
   * @returns the synchronous projection of registered workspaces.
   */
  list(): readonly { readonly path: string; readonly transport: string; readonly environmentId?: string | undefined }[]
}

/** One named-environment fact this context reads from the ssh-environments registry by name. */
interface EnvironmentLabelSource {
  /**
   * Every configured environment, in declaration order.
   * @returns the environments with the label a picker shows.
   */
  list(): readonly { readonly id: string; readonly label: string }[]
}

/**
 * Build the execution-world line for one assembly.
 * @param context - assembly context carrying the initiating agent.
 * @param workspaces - composed workspace registry, when the deployment has one.
 * @param environments - composed environment registry, when the deployment has one.
 * @returns the prompt line, or an empty string when no remote world applies.
 */
function executionWorldLine(
  context: AssembleContext,
  workspaces: WorkspaceWorldSource | undefined,
  environments: EnvironmentLabelSource | undefined,
): string {
  const cwd = context.agent?.session.header.cwd
  if (cwd === undefined || workspaces === undefined) return ''
  const workspace = workspaces.list().find(candidate => candidate.path === cwd)
  if (workspace === undefined || workspace.transport !== 'ssh') return ''
  const environmentId = workspace.environmentId
  const label = environmentId === undefined
    ? undefined
    : environments?.list().find(environment => environment.id === environmentId)?.label
  const world = environmentId === undefined
    ? 'a remote SSH host'
    : `SSH environment "${label ?? environmentId}" (${environmentId})`
  return `Your workspace ${cwd} lives in ${world}. Files, processes and sandboxing execute on that remote host, not on the machine serving this interface.`
}

/**
 * Register the execution-world context.
 * @param ctx - Cordis context of the composing plugin.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.context({
    name: 'execution-world',
    order: ctx.systemPrompt.getContextOrder('EXECUTION_WORLD'),
    // Read the optional sources per assembly: either may compose after this row.
    text: context => executionWorldLine(
      context,
      ctx.get('workspaceRegistry', false) as WorkspaceWorldSource | undefined,
      ctx.get('sshEnvironments', false) as EnvironmentLabelSource | undefined,
    ),
  })
}
