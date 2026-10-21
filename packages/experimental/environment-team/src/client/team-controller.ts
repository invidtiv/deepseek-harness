/** Coordinator team reads and explicit operator interruption for the browser dashboard. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { EnvironmentTarget } from '../workspace-types.ts'
import type { TeamDashboardRequest, TeamDashboardResult } from '../team-types.ts'

type EnvironmentId = EnvironmentTarget['environmentId']
type TeamView = Extract<TeamDashboardResult, { kind: 'team' }>
/** Last received coordinator data, retained during connection failures. */
export interface TeamState {
  targets: EnvironmentTarget[]
  environmentId?: EnvironmentId
  teamId?: TeamView['teamId']
  catalog?: Extract<TeamDashboardResult, { kind: 'catalog' }>
  detail?: TeamView
  loading: boolean
  busy: boolean
  offline: boolean
}
/** Authenticated dashboard carrier; mutation calls are never automatically retried. */
export type TeamCall = (environment: EnvironmentId, request: TeamDashboardRequest, signal: AbortSignal) => Promise<TeamDashboardResult>

/** Owns polling and cancellation independently of the selected local conversation. */
export class TeamController {
  /** Observable data for the team dashboard. */
  readonly state = createSnapshotStore<TeamState>({ targets: [], loading: false, busy: false, offline: false })
  private active = false
  private generation = 0
  private abort = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private delay: number | undefined
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly call: TeamCall,
    private readonly environments: () => Promise<EnvironmentTarget[]>,
    private readonly interval: () => Promise<number>,
    private readonly notify: (success: boolean) => void,
  ) {}

  /** Begin refreshes while the panel is visible. */
  resume(): void { this.active = true; this.refresh() }
  /** Stop network reads and timers while retaining the last received records. */
  pause(): void {
    this.active = false
    this.invalidate()
    this.state.update((value) => { value.loading = false; value.busy = false })
  }
  /** Join all outstanding reads and mutations after cancellation.
   * @returns completion after requests have released their carriers.
   */
  async dispose(): Promise<void> { this.pause(); await Promise.allSettled([...this.pending]) }
  /** Select an explicit coordinator and clear records belonging to the previous machine.
   * @param environment - selected destination identity.
   */
  selectEnvironment(environment: EnvironmentId): void {
    this.invalidate()
    this.state.update((value) => {
      value.environmentId = environment; delete value.teamId; delete value.catalog; delete value.detail
      value.offline = false; value.busy = false
    })
    if (this.active) this.refresh()
  }
  /** Select a coordinator-owned team.
   * @param teamId - identity returned by this coordinator's catalog.
   */
  selectTeam(teamId: TeamView['teamId']): void {
    this.invalidate()
    this.state.update((value) => { value.teamId = teamId; delete value.detail; value.offline = false; value.busy = false })
    if (this.active) this.refresh()
  }
  /** Refresh the catalog and selected detail without overlapping a mutation. */
  refresh(): void {
    if (!this.active || this.state.getSnapshot().busy) return
    this.invalidate()
    const generation = this.generation
    const signal = this.abort.signal
    this.track(this.read(generation, signal))
  }
  /** Interrupt one non-lead member once; an uncertain response is not replayed.
   * @param sessionId - member Session from the currently displayed roster.
   * @returns completion after the destination response or cancellation.
   */
  interrupt(sessionId: TeamView['members'][number]['sessionId']): Promise<void> {
    const { environmentId, teamId, busy } = this.state.getSnapshot()
    if (!environmentId || !teamId || busy || !this.active) return Promise.resolve()
    this.invalidate()
    const generation = this.generation
    const signal = this.abort.signal
    this.state.update((value) => { value.busy = true })
    const pending = (async () => {
      try {
        await this.call(environmentId, { action: 'interrupt', teamId, sessionId }, signal)
        this.notify(true)
      } catch {
        this.notify(false)
      } finally {
        if (generation === this.generation) {
          this.state.update((value) => { value.busy = false })
          this.refresh()
        }
      }
    })()
    this.track(pending)
    return pending
  }

  private async read(generation: number, signal: AbortSignal): Promise<void> {
    this.state.update((value) => { value.loading = true })
    try {
      const [targets, interval] = await Promise.all([this.environments(), this.interval()])
      if (generation !== this.generation) return
      this.delay = interval
      const environmentId = this.state.getSnapshot().environmentId ?? targets[0]?.environmentId
      this.state.update((value) => {
        value.targets = targets
        if (environmentId !== undefined) value.environmentId = environmentId
      })
      if (environmentId !== undefined) {
        const catalog = await this.call(environmentId, { action: 'catalog' }, signal)
        if (generation !== this.generation) return
        if (catalog.kind !== 'catalog') throw new Error('unexpected dashboard catalog')
        this.state.update((value) => { value.catalog = catalog })
        const teamId = this.state.getSnapshot().teamId
        if (teamId !== undefined) {
          const detail = await this.call(environmentId, { action: 'read', teamId }, signal)
          if (generation !== this.generation) return
          if (detail.kind !== 'team') throw new Error('unexpected dashboard detail')
          this.state.update((value) => { value.detail = detail })
        }
      }
      this.state.update((value) => { value.offline = false })
    } catch {
      if (generation !== this.generation) return
      this.state.update((value) => { value.offline = true })
    } finally {
      if (generation === this.generation) {
        this.state.update((value) => { value.loading = false })
        if (this.delay !== undefined) this.timer = setTimeout(() => { this.refresh() }, this.delay)
      }
    }
  }

  private invalidate(): void {
    this.generation++; this.abort.abort(); this.abort = new AbortController()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
  private track(pending: Promise<void>): void {
    this.pending.add(pending)
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
  }
}
