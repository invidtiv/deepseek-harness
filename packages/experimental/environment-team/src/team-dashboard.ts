/** Cordis ownership of the already-open distributed team runtime. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { TeamDashboardRequest, TeamDashboardResult } from './team-types.ts'
import type { EnvironmentId } from './protocol.ts'

/** Coordinator operations published to local operator services. */
export interface EnvironmentTeamDashboard {
  readonly environmentId: EnvironmentId
  /** Read or operate the authenticated coordinator.
   * @param peer - local operator or authenticated peer identity.
   * @param request - validated dashboard command.
   * @param signal - caller lifetime.
   * @returns coordinator-owned data.
   */
  dashboard(peer: EnvironmentId, request: TeamDashboardRequest, signal: AbortSignal): Promise<TeamDashboardResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live coordinator runtime; absent while its plugin is disabled or reloading. */
    environmentTeams: EnvironmentTeamsProvider
  }
}

/** Publish the plugin-owned runtime without opening a second durable store. */
export class EnvironmentTeamsProvider extends Service {
  constructor(ctx: Context, readonly runtime: EnvironmentTeamDashboard) {
    super(ctx, 'environmentTeams')
  }
}
