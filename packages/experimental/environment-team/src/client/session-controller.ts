/** Destination-owned session snapshots and polling lifecycle for the environment panel. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { EnvironmentWorkspace } from '../workspace-types.ts'
import type { EnvironmentSessionSummary, EnvironmentSessionFrame, EnvironmentSessionFollowRequest, SessionRequest, SessionResult } from '../session-types.ts'

type SessionList = Extract<SessionResult, { kind: 'sessions' }>
type SessionId = EnvironmentSessionSummary['sessionId']
/** Selected destination and last successfully synchronized session data. */
export interface RemoteSessionState {
  workspace?: EnvironmentWorkspace
  webUrl?: string
  list?: SessionList
  sessionId?: SessionId
  transcript?: EnvironmentSessionFrame
  loading: boolean
  offline: boolean
  busy: boolean
  draft: string
  uncertain: boolean
  streamFailure?: 'sessionDenied' | 'sessionUnsupported' | 'sessionProtocol'
}
/** Typed destination operation carrier. */
export type SessionCall = (environment: EnvironmentWorkspace['environmentId'], request: SessionRequest, signal: AbortSignal) => Promise<SessionResult>
/** Live destination stream; each frame atomically replaces the selected text view. */
export type SessionFollow = (environment: EnvironmentWorkspace['environmentId'], request: EnvironmentSessionFollowRequest, signal: AbortSignal) => AsyncIterable<EnvironmentSessionFrame>

/** Owns one selected remote workspace without borrowing local Session services. */
export class RemoteSessionController {
  /** Observable destination view retained while its panel is hidden or disconnected. */
  readonly state = createSnapshotStore<RemoteSessionState>({ loading: false, offline: false, busy: false, draft: '', uncertain: false })
  private generation = 0
  private abort = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private delay: number | undefined
  private followAbort: AbortController | undefined
  private followKey: string | undefined
  private followDone: Promise<void> = Promise.resolve()
  private catalogOffline = false
  private streamOffline = false
  private pendingPrompt: Extract<SessionRequest, { action: 'prompt' }> | undefined
  private pendingCreate: (SessionRequest & { action: 'create' }) | undefined

  /**
   * @param call - destination-scoped RPC.
   * @param interval - configured poll delay.
   * @param notify - mutation result feedback.
   * @param follow - live destination snapshot carrier.
   */
  constructor(
    private readonly call: SessionCall,
    private readonly interval: () => Promise<number>,
    private readonly notify: (success: boolean) => void,
    private readonly follow: SessionFollow,
  ) {}

  /** Replace the selected workspace and discard the previous selection's draft.
   * @param workspace - workspace registered on its owning installation.
   */
  open(workspace: EnvironmentWorkspace): void {
    this.invalidate()
    this.stopFollow()
    this.catalogOffline = false; this.streamOffline = false
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
    this.stopFollow()
    this.state.update((value) => { value.busy = false; value.uncertain = this.pendingPrompt !== undefined })
  }
  /** Stop the panel and wait until every replaced stream has released its reader.
   * @returns completion after all stream consumers have stopped.
   */
  async dispose(): Promise<void> { this.pause(); await this.followDone }
  /** Restart the selected stream after an explicit refresh or local reconnection. */
  reconnect(): void { this.stopFollow(); void this.refresh() }
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
    this.stopFollow()
    this.invalidate(); this.pendingPrompt = undefined
    this.state.update((value) => { value.sessionId = sessionId; delete value.transcript; delete value.streamFailure; value.loading = true; value.draft = ''; value.uncertain = false })
    void this.refresh()
  }
  /** Refresh authoritative catalog and selected transcript, retaining data on failure. */
  async refresh(): Promise<void> {
    if (!this.active || this.state.getSnapshot().busy) return
    this.invalidate()
    const version = this.generation
    const { workspace } = this.state.getSnapshot()
    if (!workspace) return
    this.startFollow()
    try {
      const list = await this.call(workspace.environmentId, { action: 'list', workspaceId: workspace.workspaceId }, this.abort.signal)
      if (version !== this.generation) return
      this.catalogOffline = false
      this.state.update((value) => {
        if (list.kind === 'sessions') value.list = list
        value.loading = false; value.offline = this.streamOffline
      })
    } catch {
      if (version !== this.generation) return
      this.catalogOffline = true
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
  private startFollow(): void {
    const { workspace, sessionId } = this.state.getSnapshot()
    if (!workspace || !sessionId) return
    const key = `${workspace.environmentId}:${workspace.workspaceId}:${sessionId}`
    if (this.followKey === key) return
    this.stopFollow()
    const abort = new AbortController()
    this.followAbort = abort; this.followKey = key
    this.followDone = this.followDone.then(async () => {
      if (abort.signal.aborted) return
      await this.consumeFollow(workspace, { workspaceId: workspace.workspaceId, sessionId }, abort)
    })
  }
  private async consumeFollow(
    workspace: EnvironmentWorkspace, request: EnvironmentSessionFollowRequest, abort: AbortController,
  ): Promise<void> {
    const aborted = (): boolean => abort.signal.aborted
    while (!aborted()) {
      try {
        for await (const frame of this.follow(workspace.environmentId, request, abort.signal)) {
          if (aborted()) return
          this.streamOffline = false
          this.state.update((value) => {
            value.transcript = frame; delete value.streamFailure; value.loading = false; value.offline = this.catalogOffline
          })
        }
      } catch (error: unknown) {
        if (aborted()) return
        const code = remoteErrorOf(error)?.code
        const terminal = code === 'environment/session-denied' ? 'sessionDenied'
          : code === 'environment/session-unsupported' ? 'sessionUnsupported'
            : code === 'environment/session-protocol' ? 'sessionProtocol' : undefined
        if (terminal !== undefined) {
          this.state.update((value) => { value.streamFailure = terminal; value.loading = false })
          return
        }
      }
      if (aborted()) return
      this.streamOffline = true
      this.state.update((value) => { value.loading = false; value.offline = true })
      try { this.delay = await this.interval() } catch (_error: unknown) {
        // An established configuration remains usable while the local host reconnects.
      }
      if (aborted()) return
      if (this.delay === undefined) { this.followKey = undefined; return }
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, this.delay)
        abort.signal.addEventListener('abort', done, { once: true })
      })
    }
  }
  private stopFollow(): void {
    this.followAbort?.abort()
    this.followAbort = undefined; this.followKey = undefined
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
      this.stopFollow()
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
