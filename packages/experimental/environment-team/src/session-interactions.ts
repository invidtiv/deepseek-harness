/** Explicitly authorized access to a destination Session's files, interactions and terminals. */
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig } from './config.ts'
import type { EnvironmentId } from './protocol.ts'
import { EnvironmentSessions } from './session-service.ts'
import { interactionRequestSchema, pendingInteractionSchema, terminalFollowRequestSchema } from './interaction-protocol.ts'
import type { EnvironmentInteractionRequest, EnvironmentInteractionResult, EnvironmentPendingInteraction, EnvironmentSessionAttachment, EnvironmentSessionDetail, EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from './interaction-types.ts'

const interactionEvents = ['approval/request', 'user-questions/request']

/** Operates only on ordinary Sessions within the caller's current workspace grants. */
export class EnvironmentSessionInteractions {
  constructor(private readonly ctx: Context, private readonly id: EnvironmentId, private readonly config: ResolvedConfig) {}

  /**
   * Execute an explicit destination operation after rechecking grants and ordinary Session ownership.
   * @param peer - authenticated caller or this installation's operator.
   * @param input - addressed operation validated at the carrier.
   * @param signal - caller and runtime cancellation.
   * @returns a bounded result belonging to the requested environment and Session.
   */
  async run(peer: EnvironmentId, input: EnvironmentInteractionRequest, signal: AbortSignal): Promise<EnvironmentInteractionResult> {
    const request = interactionRequestSchema.parse(input)
    this.bound(request)
    const inspection = await this.authorize(peer, request, signal)
    const scope = { environmentId: this.id, workspaceId: request.workspaceId, sessionId: request.sessionId }
    const attachments = this.files(inspection.events)
    const capabilities = this.capabilities(peer)
    let result: EnvironmentInteractionResult
    switch (request.action) {
      case 'snapshot': {
        const details = this.details(inspection.events)
        const files = capabilities.attachments ? [...attachments.values()].map(file => file.metadata) : []
        const pending = capabilities.approvals ? this.pending(request.sessionId) : []
        const terminals = capabilities.terminals ? this.service('terminalController').list(request.sessionId) : []
        const emptyRequest = { kind: 'session-interaction', environmentId: this.id, request: { action: 'upload', workspaceId: request.workspaceId, sessionId: request.sessionId, name: '', data: '' } }
        const wireBytes = Math.max(0, this.config.maxBytes - Buffer.byteLength(JSON.stringify(emptyRequest)))
        result = { ...scope, kind: 'snapshot', capabilities, pending: pending.slice(0, this.config.sessionPageSize), attachments: files.slice(-this.config.sessionPageSize), details: details.slice(-this.config.sessionPageSize), terminals: terminals.slice(0, this.config.sessionPageSize), maxUploadBytes: Math.min(this.config.maxUploadBytes, Math.floor(wireBytes / 4) * 3), terminalCols: this.config.terminalCols, terminalRows: this.config.terminalRows, truncated: [details.length, files.length, pending.length, terminals.length].some(length => length > this.config.sessionPageSize) }
        break
      }
      case 'upload': {
        this.require(capabilities.attachments)
        if (Buffer.byteLength(request.data, 'base64') > this.config.maxUploadBytes) throw new Error('Upload exceeds the configured byte limit')
        const agent = await this.agent(request.sessionId, signal)
        result = { ...scope, kind: 'uploaded', upload: await this.service('fileUploads').upload(agent, { data: request.data, name: request.name }, signal) }
        break
      }
      case 'download': {
        this.require(capabilities.attachments)
        const file = attachments.get(request.attachmentId)
        this.require(file !== undefined)
        if (file.part.attachment.bytes > this.config.maxUploadBytes) throw new Error('Download exceeds the configured byte limit')
        let bytes: Uint8Array
        if (file.part.type === 'image') bytes = (await this.service('attachments').readImage(file.part.attachment, signal)).data
        else {
          const chunks: Uint8Array[] = []
          let size = 0
          for await (const chunk of this.service('attachments').readFileStream(file.part.attachment, signal)) {
            size += chunk.byteLength
            if (size > this.config.maxUploadBytes) throw new Error('Download exceeds the configured byte limit')
            chunks.push(chunk)
          }
          bytes = Buffer.concat(chunks)
        }
        result = { ...scope, kind: 'download', attachment: file.metadata, data: Buffer.from(bytes).toString('base64') }
        break
      }
      case 'approval':
      case 'answer': {
        this.require(capabilities.approvals)
        const pending = this.pending(request.sessionId).find(item => item.id === request.id)
        if (!pending || (request.action === 'approval' ? pending.kind !== 'approval' : pending.kind !== 'questions')) throw new Error('Interaction is no longer available')
        if (request.action === 'answer' && pending.kind === 'questions') {
          const answers = request.answer.answers
          if (answers.length !== pending.questions.length || new Set(answers.map(answer => answer.id)).size !== answers.length) throw new Error('Answer must cover each question exactly once')
          for (const question of pending.questions) {
            const answer = answers.find(item => item.id === question.id)
            if (!answer || (!question.multiSelect && answer.selected.length > 1) || answer.selected.some(value => !question.options?.some(option => option.label === value)) || (answer.selected.length === 0 && !answer.custom?.trim())) throw new Error('Answer does not match the pending question')
          }
        }
        const settled = this.service('remoteEventAccess').respond(request.sessionId, request.id, request.action === 'approval' ? 'approval/request' : 'user-questions/request', request.action === 'approval' ? request.decision : request.answer)
        if (!settled) throw new Error('Interaction was already settled')
        result = { ...scope, kind: 'acknowledged' }
        break
      }
      case 'terminal-create': {
        this.require(capabilities.terminals)
        result = { ...scope, kind: 'terminal', terminal: await this.service('terminalController').create(await this.agent(request.sessionId, signal), request.request, signal) }
        break
      }
      case 'terminal-write':
      case 'terminal-resize':
      case 'terminal-close': {
        this.require(capabilities.terminals)
        const agent = await this.agent(request.sessionId, signal)
        if (request.action === 'terminal-write') await this.service('terminalController').write(agent, request.terminalId, request.attachmentId, request.data)
        else if (request.action === 'terminal-resize') await this.service('terminalController').resize(agent, request.terminalId, request.attachmentId, request.cols, request.rows)
        else await this.service('terminalController').close(agent, request.terminalId)
        result = { ...scope, kind: 'acknowledged' }
        break
      }
      default: return assertNever(request)
    }
    this.bound(result)
    return result
  }

  /**
   * Open ordered terminal output under a distinct terminal grant; closing the stream preserves its process.
   * @param peer - authenticated caller or local operator.
   * @param input - owning Session and fresh physical input attachment.
   * @param signal - physical stream and runtime lifetime.
   * @returns initial recovery screen followed by ordered output and terminal status.
   */
  async *followTerminal(
    peer: EnvironmentId, input: EnvironmentTerminalFollowRequest, signal: AbortSignal,
  ): AsyncIterable<EnvironmentTerminalFrame> {
    const request = terminalFollowRequestSchema.parse(input)
    await this.authorize(peer, request, signal)
    this.require(this.capabilities(peer).terminals)
    const agent = await this.agent(request.sessionId, signal)
    for await (const frame of this.service('terminalController').follow(agent, request.terminalId, request.attachmentId, signal)) {
      const result = {
        environmentId: this.id, workspaceId: request.workspaceId, sessionId: request.sessionId, terminalId: request.terminalId, frame,
      }
      this.bound(result)
      yield result
    }
  }

  private async authorize(
    peer: EnvironmentId, request: EnvironmentTerminalFollowRequest | EnvironmentInteractionRequest, signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    const workspace = await new EnvironmentSessions(this.ctx, this.id, this.config).authorize(peer, { action: 'read', workspaceId: request.workspaceId, sessionId: request.sessionId })
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new Error('Session controller is unavailable')
    const inspection = await controller.inspect(request.sessionId, signal)
    if (inspection.meta.origin === 'subagent' || inspection.meta.parentSession !== undefined || inspection.meta.cwd === undefined || await realpath(inspection.meta.cwd) !== await realpath(workspace.path)) throw new RemoteError('environment/session-denied', 'Session does not belong to this workspace', {})
    signal.throwIfAborted()
    return inspection
  }

  private async agent(sessionId: EnvironmentInteractionRequest['sessionId'], signal: AbortSignal) {
    const result = await this.service('sessionController').resolveAgent(sessionId)
    signal.throwIfAborted()
    if ('error' in result) throw new Error('Session could not be activated')
    return result.agent
  }

  private service<K extends 'terminalController' | 'fileUploads' | 'attachments' | 'remoteEventAccess' | 'sessionController'>(name: K): Context[K] {
    const service = this.ctx.get(name)
    if (!service) throw new Error(`Destination service is unavailable: ${name}`)
    return service
  }
  private capabilities(peer: EnvironmentId) {
    const grant = this.config.peers.find(item => item.environmentId === peer)
    const local = peer === this.id
    return {
      attachments: (local || grant?.attachmentAccess === true) && !!this.ctx.get('fileUploads') && !!this.ctx.get('attachments'),
      approvals: (local || grant?.approvalAccess === true) && !!this.ctx.get('remoteEventAccess'),
      terminals: (local || grant?.terminalAccess === true) && !!this.ctx.get('terminalController'),
    }
  }

  private pending(sessionId: EnvironmentInteractionRequest['sessionId']): EnvironmentPendingInteraction[] {
    return this.service('remoteEventAccess').pending(sessionId, interactionEvents).map(frame => frame.event === 'approval/request'
      ? pendingInteractionSchema.parse({ kind: 'approval', id: frame.eventId, toolName: frame.request.toolName, ...(frame.request.reason === undefined ? {} : { reason: frame.request.reason }), ...(frame.request.callId === undefined ? {} : { callId: frame.request.callId }) })
      : pendingInteractionSchema.parse({ kind: 'questions', id: frame.eventId, questions: frame.request.questions }))
  }

  private files(events: readonly SessionEvent[]) {
    const files = new Map<EnvironmentSessionAttachment['attachmentId'], { part: Extract<ContentBlock, { type: 'file' | 'image' }>; metadata: EnvironmentSessionAttachment }>()
    for (const event of events) {
      const content = event.type === 'user/message' ? event.data.content : event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message.content : []
      for (const part of content) {
        if (part.type !== 'image' && part.type !== 'file') continue
        files.set(part.attachment.attachmentId, { part, metadata: { attachmentId: part.attachment.attachmentId, bytes: part.attachment.bytes, name: part.attachment.name ?? part.attachment.attachmentId, mediaType: part.type === 'image' ? part.attachment.mediaType : 'application/octet-stream' } })
      }
    }
    return files
  }

  private details(events: readonly SessionEvent[]): EnvironmentSessionDetail[] {
    return events.flatMap((event): EnvironmentSessionDetail[] => {
      if (event.type === 'tool/call') return [{ seq: event.seq, kind: 'tool-call', title: event.data.name, text: event.data.arguments, callId: event.data.callId, isError: false }]
      if (event.type === 'tool/result') return [{ seq: event.seq, kind: 'tool-result', title: event.data.message.toolCallId, text: event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), callId: event.data.message.toolCallId, isError: event.data.message.isError === true }]
      if (event.type === 'turn/end' && event.data.reason.kind === 'error') return [{ seq: event.seq, kind: 'error', title: 'error', text: JSON.stringify(event.data.reason.error), isError: true }]
      return []
    })
  }

  private require(allowed: boolean): asserts allowed {
    if (!allowed) throw new RemoteError('environment/session-denied', 'This operation is not granted for the destination Session', {})
  }

  private bound(value: object): void {
    if (Buffer.byteLength(JSON.stringify(value)) > this.config.maxBytes) throw new RemoteError('environment/session-protocol', 'Session operation byte limit reached', {})
  }
}
