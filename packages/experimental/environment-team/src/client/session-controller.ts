/** Destination-owned session snapshots and polling lifecycle for the environment panel. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { EnvironmentWorkspace } from '../workspace-types.ts'
import type { EnvironmentSessionSummary, SessionRequest, SessionResult } from '../session-types.ts'

type SessionList = Extract<SessionResult, { kind: 'sessions' }>
type SessionSnapshot = Extract<SessionResult, { kind: 'snapshot' }>
type SessionId = EnvironmentSessionSummary['sessionId']
/** Selected destination and last successfully synchronized session data. */
export interface RemoteSessionState {
  workspace?: EnvironmentWorkspace
  webUrl?: string
  list?: SessionList
  sessionId?: SessionId
  transcript?: SessionSnapshot
  loading: boolean
  offline: boolean
  busy: boolean
  draft: string
  uncertain: boolean
}
/** Typed destination operation carrier. */
export type SessionCall = (environment: EnvironmentWorkspace['environmentId'], request: SessionRequest, signal: AbortSignal) => Promise<SessionResult>

/** Owns one selected remote workspace without borrowing local Session services. */
export class RemoteSessionController {
  /** Observable destination view retained while its panel is hidden or disconnected. */
  readonly state = createSnapshotStore<RemoteSessionState>({ loading: false, offline: false, busy: false, draft: '', uncertain: false })
  private generation = 0
  private abort = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private delay: number | undefined
  private pendingPrompt: Extract<SessionRequest, { action: 'prompt' }> | undefined
  private pendingCreate: (SessionRequest & { action: 'create' }) | undefined

  /**
   * @param call - destination-scoped RPC.
   * @param interval - configured poll delay.
   * @param notify - mutation result feedback.
   */
  constructor(
    private readonly call: SessionCall,
    private readonly interval: () => Promise<number>,
    private readonly notify: (success: boolean) => void,
  ) {}

  /** Replace the selected workspace and discard the previous selection's draft.
   * @param workspace - workspace registered on its owning installation.
   */
  open(workspace: EnvironmentWorkspace): void {
    this.invalidate()
    this.pendingPrompt = undefined
    this.pendingCreate = undefined
    this.state.set({ workspace, loading: true, offline: false, busy: false, draft: '', uncertain: false })
  }
  /** Publish a Web link only for the currently selected destination.
   * @param environment - identity owning the resolved endpoint.
   * @param url - configured Web endpoint without credentials.
   */
  destination(environment: EnvironmentWorkspace['environmentId'], url: string): void {
    if (this.state.getSnapshot().workspace?.environmentId !== environment) return
    this.state.update((value) => { value.webUrl = url })
  }
  /** Start refreshing while the panel is visible. */
  resume(): void { this.active = true; void this.refresh() }
  /** Stop in-flight reads and timers while preserving the last received transcript. */
  pause(): void {
    this.active = false; this.invalidate()
    this.state.update((value) => { value.busy = false; value.uncertain = this.pendingPrompt !== undefined })
  }
  /** Update the draft unless a submission is pending or awaiting retry.
   * @param text - draft retained until the destination acknowledges submission.
   */
  draft(text: string): void {
    if (this.state.getSnapshot().busy || this.pendingPrompt) return
    this.state.update((value) => { value.draft = text })
  }
  /** Select a Session and refresh its destination-owned saved messages.
   * @param sessionId - session selected inside the current destination workspace.
   */
  select(sessionId: SessionId): void {
    if (this.state.getSnapshot().busy) return
    this.invalidate(); this.pendingPrompt = undefined
    this.state.update((value) => { value.sessionId = sessionId; delete value.transcript; value.loading = true; value.draft = ''; value.uncertain = false })
    void this.refresh()
  }
  /** Refresh authoritative catalog and selected transcript, retaining data on failure. */
  async refresh(): Promise<void> {
    if (!this.active || this.state.getSnapshot().busy) return
    this.invalidate()
    const version = this.generation
    const { workspace, sessionId } = this.state.getSnapshot()
    if (!workspace) return
    try {
      const list = await this.call(workspace.environmentId, { action: 'list', workspaceId: workspace.workspaceId }, this.abort.signal)
      const transcript = sessionId ? await this.call(workspace.environmentId, { action: 'read', workspaceId: workspace.workspaceId, sessionId }, this.abort.signal) : undefined
      if (version !== this.generation) return
      this.state.update((value) => {
        if (list.kind === 'sessions') value.list = list
        if (transcript?.kind === 'snapshot') value.transcript = transcript
        value.loading = false; value.offline = false
      })
    } catch {
      if (version !== this.generation) return
      this.state.update((value) => { value.loading = false; value.offline = true })
    }
    if (version !== this.generation) return
    try {
      this.delay = await this.interval()
    } catch {
      if (version === this.generation) this.state.update((value) => { value.offline = true })
    }
    if (version === this.generation && this.delay !== undefined) {
      this.timer = setTimeout(() => { void this.refresh() }, this.delay)
    }
  }
  /** Create a destination session; retries reuse its caller-allocated identity. */
  async create(): Promise<void> {
    const state = this.state.getSnapshot()
    if (!state.workspace || state.busy) return
    const request: SessionRequest & { action: 'create' } = this.pendingCreate ?? { action: 'create', workspaceId: state.workspace.workspaceId, sessionId: brandString<SessionId>(randomUUID()) }
    this.pendingCreate = request
    await this.mutate(state.workspace, request, (result) => {
      if (result.kind !== 'created') throw new Error('Unexpected session creation result')
      this.pendingCreate = undefined
      this.pendingPrompt = undefined
      this.state.update((value) => { value.sessionId = result.sessionId; delete value.transcript; value.draft = ''; value.uncertain = false })
    })
  }
  /** Submit the draft, retaining the operation identity after an ambiguous failure. */
  async send(): Promise<void> {
    const state = this.state.getSnapshot()
    if (!state.workspace || !state.sessionId || state.busy || !state.draft.trim()) return
    const request: Extract<SessionRequest, { action: 'prompt' }> = this.pendingPrompt ?? { action: 'prompt', workspaceId: state.workspace.workspaceId, sessionId: state.sessionId, requestId: brandString<Extract<SessionRequest, { action: 'prompt' }>['requestId']>(randomUUID()), text: state.draft }
    this.pendingPrompt = request
    await this.mutate(state.workspace, request, () => {
      this.pendingPrompt = undefined
      this.state.update((value) => { value.draft = ''; value.uncertain = false })
    })
  }
  /** Request cancellation on the selected destination session. */
  async cancel(): Promise<void> {
    const state = this.state.getSnapshot()
    if (!state.workspace || !state.sessionId || state.busy) return
    await this.mutate(state.workspace, { action: 'cancel', workspaceId: state.workspace.workspaceId, sessionId: state.sessionId }, () => {})
  }
  private async mutate(workspace: EnvironmentWorkspace, request: SessionRequest, accept: (result: SessionResult) => void): Promise<void> {
    this.invalidate()
    const version = this.generation
    this.state.update((value) => { value.busy = true })
    try {
      const result = await this.call(workspace.environmentId, request, this.abort.signal)
      if (version !== this.generation) return
      accept(result); this.notify(true)
    } catch {
      if (version !== this.generation) return
      this.state.update((value) => { value.uncertain = request.action === 'prompt' })
      this.notify(false)
    } finally {
      if (version === this.generation) {
        this.state.update((value) => { value.busy = false })
        void this.refresh()
      }
    }
  }
  private invalidate(): void {
    this.generation++; this.abort.abort(); this.abort = new AbortController()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
