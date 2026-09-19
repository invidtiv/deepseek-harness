/**
 * Execution-world label for one Workspace row: the label its named SSH
 * environment declares, the id when the served list does not name that
 * environment, or the generic remote-server label for an SSH world with no
 * registry entry. A Workspace on the Harness host's own filesystem has no
 * label — the default needs none.
 */
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * Resolve the server a Workspace's directories live in.
 * @param workspace - Workspace row carrying the recorded transport locator.
 * @param labels - display label of each served environment, by environment id.
 * @param remoteLabel - localized fallback for a remote world with no named environment.
 * @returns the environment label or id, the fallback label, or undefined for the host's own filesystem.
 */
export function workspaceServerLabel(
  workspace: Pick<WorkspaceView, 'transport' | 'environmentId'>,
  labels: ReadonlyMap<string, string>,
  remoteLabel: string,
): string | undefined {
  if (workspace.transport === 'local') return undefined
  if (workspace.environmentId === undefined) return remoteLabel
  return labels.get(workspace.environmentId) ?? workspace.environmentId
}
