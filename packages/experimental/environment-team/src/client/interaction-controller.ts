/** Destination-owned conversation controls; reads may recover, mutations never replay automatically. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { EnvironmentWorkspace } from '../workspace-types.ts'
import type { EnvironmentSessionFollowRequest } from '../session-types.ts'
import type { EnvironmentInteractionRequest, EnvironmentInteractionResult, EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from '../interaction-types.ts'

type Address = EnvironmentSessionFollowRequest & Pick<EnvironmentWorkspace, 'environmentId'>
type Snapshot = Extract<EnvironmentInteractionResult, { kind: 'snapshot' }>
/** Operation fields supplied by browser controls; the controller adds the destination address. */
export type InteractionCommand = EnvironmentInteractionRequest extends infer R
  ? R extends EnvironmentInteractionRequest ? Omit<R, keyof EnvironmentSessionFollowRequest> : never : never
/** Destination conversation controls retained through transport interruptions. */
export interface InteractionState {
  address?: Address
  snapshot?: Snapshot
  loading: boolean
  busy: boolean
  offline: boolean
  terminal?: EnvironmentTerminalFollowRequest
  terminalFrame?: EnvironmentTerminalFrame
  terminalInfo?: Snapshot['terminals'][number]
  terminalRevision: number
  terminalOffline: boolean
}
/** Explicitly scoped interaction request carrier. */
export type InteractionCall = (environment: Address['environmentId'], request: EnvironmentInteractionRequest, signal: AbortSignal) => Promise<EnvironmentInteractionResult>
/** Ordered terminal carrier with an independent physical input attachment. */
export type TerminalFollow = (environment: Address['environmentId'], request: EnvironmentTerminalFollowRequest, signal: AbortSignal) => AsyncIterable<EnvironmentTerminalFrame>

/** Controls one selected destination Session without accessing local Session services. */
export class RemoteInteractionController {
  /** Observable data consumed through renderer-owned hooks. */
  readonly state = createSnapshotStore<InteractionState>({
    loading: false, busy: false, offline: false, terminalRevision: 0, terminalOffline: false,
  })
  private active = false
  private generation = 0
  private abort = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private terminalAbort: AbortController | undefined
  private terminalDone = Promise.resolve()
  private presented: (() => void) | undefined
  private delay?: number
  private mutation?: Promise<EnvironmentInteractionResult | undefined>
  private inputDone = Promise.resolve()
  private readVersion = 0

  /**
   * @param call - authenticated destination operations.
   * @param follow - ordered terminal screen carrier.
   * @param interval - configured refresh and reconnect delay.
   * @param notify - completed mutation feedback outside the panel.
   */
  constructor(
    private readonly call: InteractionCall, private readonly follow: TerminalFollow,
    private readonly interval: () => Promise<number>, private readonly notify: (success: boolean) => void,
  ) {}

  /** Change destination and cancel the previous selection's reads and controls.
   * @param address - owning environment, workspace and Session, or no selection.
   */
  select(address?: Address): void {
    const previous = this.state.getSnapshot().address
    if (previous?.environmentId === address?.environmentId && previous?.workspaceId === address?.workspaceId
      && previous?.sessionId === address?.sessionId) return
    this.stop()
    this.state.set({
      ...(address ? { address } : {}), loading: address !== undefined,
      busy: false, offline: false, terminalRevision: 0, terminalOffline: false,
    })
    if (this.active) void this.refresh()
  }
  /** Resume reads while the panel is visible. */
  resume(): void {
    this.active = true; void this.refresh()
    const terminal = this.state.getSnapshot().terminal
    if (terminal && !this.terminalAbort) this.connectTerminal(terminal.terminalId)
  }
  /** Cancel physical connections while keeping the displayed data. */
  pause(): void { this.active = false; this.stop(); this.state.update((value) => { value.busy = false }) }
  /** Dispose physical streams and pending requests.
   * @returns completion after active consumers release their readers.
   */
  async dispose(): Promise<void> { this.pause(); await Promise.all([this.terminalDone, this.mutation, this.inputDone]) }
  /** Refresh pending questions, files, tools and terminal metadata. */
  async refresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    const { address } = this.state.getSnapshot()
    if (!this.active || !address) return
    const generation = this.generation
    const readVersion = ++this.readVersion
    try {
      const result = await this.call(address.environmentId, { ...address, action: 'snapshot' }, this.abort.signal)
      if (generation !== this.generation || readVersion !== this.readVersion) return
      if (result.kind !== 'snapshot') throw new Error('Expected interaction snapshot')
      this.state.update((value) => { value.snapshot = result; value.loading = false; value.offline = false })
    } catch {
      if (generation !== this.generation || readVersion !== this.readVersion) return
      this.state.update((value) => { value.loading = false; value.offline = true })
    }
    try { this.delay = await this.interval() } catch (_error: unknown) {
      // Retain the last deployment interval during a local connection outage.
    }
    if (generation === this.generation && readVersion === this.readVersion && this.delay !== undefined) {
      this.timer = setTimeout(() => { void this.refresh() }, this.delay)
    }
  }
  /** Run one explicit operation; an ambiguous failure is never automatically repeated.
   * @param command - operation inside the currently selected Session.
   * @returns acknowledged result, or undefined after failure or selection change.
   */
  async run(command: InteractionCommand): Promise<EnvironmentInteractionResult | undefined> {
    const { address, busy } = this.state.getSnapshot()
    if (!address || busy) return
    const generation = this.generation
    this.state.update((value) => { value.busy = true })
    const request = { ...command, workspaceId: address.workspaceId, sessionId: address.sessionId }
    const operation = this.call(address.environmentId, request, this.abort.signal)
      .then((result) => {
        if (generation !== this.generation) return
        this.notify(true)
        return result
      }, (_error: unknown) => { if (generation === this.generation) this.notify(false); return undefined })
      .finally(() => {
        if (generation === this.generation) { this.state.update((value) => { value.busy = false }); void this.refresh() }
      })
    this.mutation = operation
    return operation
  }
  /** Attach to one destination terminal with a fresh physical input identity.
   * @param terminalId - terminal returned by this Session's catalog.
   */
  connectTerminal(terminalId: EnvironmentTerminalFollowRequest['terminalId']): void {
    const { address } = this.state.getSnapshot()
    if (!address || !this.active) return
    this.stopTerminal()
    const abort = new AbortController()
    const aborted = (): boolean => abort.signal.aborted
    this.terminalAbort = abort
    const request: EnvironmentTerminalFollowRequest = { workspaceId: address.workspaceId, sessionId: address.sessionId, terminalId, attachmentId: brandString<EnvironmentTerminalFollowRequest['attachmentId']>(randomUUID()) }
    this.state.update((value) => {
      value.terminal = request; delete value.terminalFrame; delete value.terminalInfo; value.terminalOffline = false
    })
    this.terminalDone = this.terminalDone.then(async () => {
      if (aborted()) return
      try {
        for await (const frame of this.follow(address.environmentId, request, abort.signal)) {
          if (aborted()) return
          await new Promise<void>((resolve) => {
            this.presented = resolve
            this.state.update((value) => {
              value.terminalFrame = frame; value.terminalRevision++; value.terminalOffline = false
              if (frame.frame.type !== 'output') value.terminalInfo = frame.frame.info
            })
          })
        }
      } catch (_error: unknown) { /* The retained screen remains visible; reconnect explicitly acquires fresh input control. */ }
      if (!aborted()) this.state.update((value) => { value.terminalOffline = true })
    })
  }
  /** Acknowledge rendered output before reading another frame, preserving order and backpressure.
   * @param revision - exact screen update applied by the emulator.
   */
  rendered(revision: number): void {
    if (this.state.getSnapshot().terminalRevision !== revision) return
    this.presented?.(); this.presented = undefined
  }
  /** Serialize human terminal input without replaying uncertain bytes.
   * @param data - keyboard or paste bytes from the current emulator.
   */
  write(data: string): void {
    const { address, terminal, terminalOffline } = this.state.getSnapshot()
    if (!address || !terminal || terminalOffline) return
    const generation = this.generation
    const abort = this.terminalAbort
    const aborted = (): boolean => abort === undefined || abort.signal.aborted
    this.inputDone = this.inputDone.then(async () => {
      if (generation !== this.generation || !abort || aborted() || this.state.getSnapshot().terminalOffline) return
      try {
        await this.call(address.environmentId, { ...terminal, action: 'terminal-write', data }, abort.signal)
      } catch (_error: unknown) {
        if (generation !== this.generation || aborted()) return
        this.state.update((value) => { value.terminalOffline = true }); this.notify(false)
      }
    })
  }
  private stopTerminal(): void {
    this.terminalAbort?.abort(); this.terminalAbort = undefined; this.presented?.(); this.presented = undefined
  }
  private stop(): void {
    this.generation++; this.abort.abort(); this.abort = new AbortController()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.stopTerminal()
  }
}
