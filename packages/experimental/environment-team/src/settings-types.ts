/** Configuration page values; peer secrets never appear in this response. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { EnvironmentTeamConfig } from './config-types.ts'
export type { EnvironmentTarget, EnvironmentWorkspace, WorkspaceRequest, WorkspaceResult } from './workspace-types.ts'

/** Optimistically edited environment configuration. */
export interface EnvironmentConfiguration {
  /** Public installation identity displayed for pairing. */
  environmentId: Branded<'EnvironmentId'>
  /** Revision returned by the last read. */
  revision: Branded<'EnvironmentConfigurationRevision'>
  /** Deployment values, with credential references instead of secrets. */
  config: Required<EnvironmentTeamConfig>
}
