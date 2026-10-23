/** Destination-owned Session commands and cold text snapshots within current workspace grants. */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResolvedConfig } from './config.ts'
import type { EnvironmentId } from './protocol.ts'
import type { EnvironmentSessionFollowRequest, EnvironmentSessionFrame, EnvironmentSessionMessage, SessionRequest, SessionResult } from './session-types.ts'
import { sessionFollowRequestSchema, sessionRequestSchema } from './session-protocol.ts'
import { EnvironmentSessionFollowProjection } from './session-follow.ts'
import { pinAttachmentPrompt } from './prompt-receipt.ts'

// The environment ownership lock excludes concurrent writers; Context-specific service proxies do not share identity.
const admissions = new Map<EnvironmentId, Map<string, Promise<SessionResult>>>()

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

/** Operates on ordinary Sessions without copying their persistence to the caller. */
export class EnvironmentSessions {
  constructor(private readonly ctx: Context, private readonly id: EnvironmentId, private readonly config: ResolvedConfig) {}

  /**
   * Follow the owning Session without copying its log or cancelling its Agent on disconnect.
   * @param peer - authenticated caller environment, or this environment's operator.
   * @param input - destination workspace and ordinary Session identities.
   * @param signal - subscription lifetime; abort before awaiting iterator teardown.
   * @returns bounded replacement views with saved messages and optional process-local assistant text.
   */
  async *follow(
    peer: EnvironmentId, input: EnvironmentSessionFollowRequest, signal: AbortSignal,
  ): AsyncIterable<EnvironmentSessionFrame> {
    const request = sessionFollowRequestSchema.parse(input)
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new RemoteError('environment/session-unsupported', 'ordinary session follow is unavailable', {})
    signal.throwIfAborted()
    let workspace: Workspace
    try { workspace = await this.authorize(peer, { action: 'read', ...request }) } catch (error) {
      throw new RemoteError('environment/session-denied', 'session access is not granted', {}, { cause: error })
    }
    const projection = new EnvironmentSessionFollowProjection(this.config.sessionPageSize)
    for await (const frame of controller.follow({ address: { kind: 'session', sessionId: request.sessionId }, assistantStream: true, maxMessages: this.config.sessionPageSize }, signal)) {
      signal.throwIfAborted()
      if (frame.type === 'snapshot') {
        if (frame.header.id !== request.sessionId || frame.header.origin === 'subagent' || frame.header.parentSession !== undefined || frame.header.cwd === undefined || await realpath(frame.header.cwd) !== await realpath(workspace.path)) {
          throw new RemoteError('environment/session-denied', 'session does not belong to the workspace', {})
        }
      }
      let view: ReturnType<EnvironmentSessionFollowProjection['accept']>
      try { view = projection.accept(frame, this.ctx.agents.get(request.sessionId)?.status === 'running') } catch (error) {
        if (error instanceof RemoteError) throw error
        throw new RemoteError('environment/session-protocol', 'session follow continuity failed', {}, { cause: error })
      }
      const result: EnvironmentSessionFrame = {
        kind: 'snapshot', environmentId: this.id, workspaceId: workspace.id, sessionId: request.sessionId,
        ...view,
      }
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxBytes) throw new RemoteError('environment/session-protocol', 'session frame byte limit reached', {})
      yield result
    }
  }

  /**
   * Authorize one operation against destination workspace membership before accessing a Session.
   * @param peer - authenticated caller environment, or this environment for its operator.
   * @param input - validated workspace and Session identities with stable mutation retry IDs.
   * @param signal - cancellation before admission and during cold reads.
   * @returns a fully scoped bounded response; mutation acknowledgement does not imply turn completion.
   */
  async run(peer: EnvironmentId, input: SessionRequest, signal: AbortSignal): Promise<SessionResult> {
    const request = sessionRequestSchema.parse(input)
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new Error('ordinary session operations are unavailable')
    const query = this.ctx.get('sessionQuery')
    if (!query) throw new Error('ordinary session reads are unavailable')
    const execute = async (): Promise<SessionResult> => {
      signal.throwIfAborted()
      const workspace = await this.authorize(peer, request)
      signal.throwIfAborted()
      if (request.action === 'prompt' || request.action === 'cancel') {
        using snapshot = await query.observeSession(request.sessionId, { signal })
        if (snapshot.header.origin === 'subagent' || snapshot.header.parentSession !== undefined || snapshot.header.cwd === undefined || await realpath(snapshot.header.cwd) !== await realpath(workspace.path)) throw new Error('session does not belong to the workspace')
        if (request.action === 'prompt') {
          const attached = (request.attachments?.length ?? 0) > 0 || (request.images?.length ?? 0) > 0
          if (attached && peer !== this.id && !this.config.peers.find(item => item.environmentId === peer)?.attachmentAccess) throw new Error('attachment access is not granted')
          if (Buffer.byteLength(JSON.stringify(request)) > this.config.maxBytes) throw new Error('prompt request byte limit reached')
          if (request.images?.some(image => Buffer.byteLength(image.data, 'base64') > this.config.maxUploadBytes)) throw new Error('Image exceeds the configured byte limit')
          const agent = this.ctx.agents.get(request.sessionId)
          const previous: UserMessage[] = snapshot.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
          if (agent) previous.push(...agent.inbox.nextTurn, ...agent.inbox.nextStep)
          const matching = previous.filter(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === request.requestId)
          if (!attached) for (const message of matching) {
            if (message.content.length !== 1 || message.content[0]?.type !== 'text' || message.content[0].text !== request.text) throw new Error('prompt retry identity has different content')
          }
          await pinAttachmentPrompt(this.config.stateDirectory, this.id, request, attached && matching.length > 0)
        }
      }
      signal.throwIfAborted()
      const result = await this.execute(controller, workspace, request, signal)
      if (Buffer.byteLength(JSON.stringify({ environmentId: this.id, result: JSON.stringify(result) })) > this.config.maxBytes) throw new Error('session result byte limit reached')
      return result
    }
    if (request.action === 'list' || request.action === 'read') return execute()
    let queue = admissions.get(this.id)
    if (!queue) { queue = new Map(); admissions.set(this.id, queue) }
    const previous = queue.get(request.sessionId)
    const pending = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(execute)
    queue.set(request.sessionId, pending)
    try { return await pending } finally {
      if (queue.get(request.sessionId) === pending) queue.delete(request.sessionId)
      if (queue.size === 0) admissions.delete(this.id)
    }
  }

  /**
   * Validate the caller's grant and registered workspace membership before any Session access.
   * @param peer - authenticated environment or local operator identity.
   * @param request - validated workspace operation.
   * @returns the authorized destination workspace.
   */
  async authorize(peer: EnvironmentId, request: SessionRequest): Promise<Workspace> {
    const grant = this.config.peers.find(item => item.environmentId === peer)
    if (peer !== this.id && !grant?.sessionAccess) throw new Error('session access is not granted')
    const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
    if (!workspace) throw new Error('workspace is not available')
    const target = await realpath(workspace.path)
    const roots = await Promise.all(Object.entries(this.config.workspaces)
      .filter(([alias]) => peer === this.id || grant?.workspaces.includes(alias))
      .map(([, path]) => realpath(path)))
    if (!roots.some(root => within(root, target))) throw new Error('workspace is outside the granted roots')
    if (request.action !== 'list' && request.action !== 'create' && !workspace.sessionIds.includes(request.sessionId)) throw new Error('session does not belong to the workspace')
    return workspace
  }

  private async execute(
    controller: SessionController, workspace: Workspace, request: SessionRequest, signal: AbortSignal,
  ): Promise<SessionResult> {
    const query = this.ctx.get('sessionQuery')
    if (!query) throw new Error('ordinary session reads are unavailable')
    const scope = { environmentId: this.id, workspaceId: workspace.id }
    switch (request.action) {
      case 'list': {
        const { items } = await controller.list({}, signal)
        const visible = items.filter(item => workspace.sessionIds.includes(item.sessionId) && item.origin !== 'subagent' && item.parentSessionId === undefined)
          .filter(item => request.before === undefined || item.updatedAt < request.before.updatedAt ||
            (item.updatedAt === request.before.updatedAt && item.sessionId < request.before.sessionId))
          .sort((left, right) => right.updatedAt - left.updatedAt ||
            (left.sessionId < right.sessionId ? 1 : left.sessionId > right.sessionId ? -1 : 0))
        return { ...scope, kind: 'sessions', sessions: visible.slice(0, this.config.sessionPageSize).map(item => ({ sessionId: item.sessionId, title: typeof item.projections?.values.title === 'string' ? item.projections.values.title : item.sessionId, running: item.running, updatedAt: item.updatedAt })), truncated: visible.length > this.config.sessionPageSize }
      }
      case 'create': {
        const created = await controller.create({
          workspaceId: workspace.id, sessionId: request.sessionId, agentPreset: this.config.agentPreset,
        })
        return { ...scope, kind: 'created', sessionId: created.sessionId }
      }
      case 'read': {
        using snapshot = await query.observeSession(request.sessionId, { signal })
        if (snapshot.header.origin === 'subagent' || snapshot.header.parentSession !== undefined || snapshot.header.cwd === undefined || await realpath(snapshot.header.cwd) !== await realpath(workspace.path)) throw new Error('session does not belong to the workspace')
        const messages: EnvironmentSessionMessage[] = []
        for (const event of snapshot.events) {
          if (request.beforeSeq !== undefined && event.seq >= request.beforeSeq) continue
          if (!isAppendSurfaceEvent(event) || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue
          const message = event.type === 'user/message' ? event.data : event.data.message
          if (event.type === 'user/message' && message.source.kind !== 'user') continue
          const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          if (text.length > 0) messages.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text })
        }
        return { ...scope, kind: 'snapshot', sessionId: request.sessionId, cursor: snapshot.events.at(-1)?.seq ?? -1, running: this.ctx.agents.get(request.sessionId)?.status === 'running', messages: messages.slice(-this.config.sessionPageSize), truncated: messages.length > this.config.sessionPageSize }
      }
      case 'prompt': {
        const content: PromptContentPart[] = [{ type: 'text', text: request.text }]
        for (const receiptId of request.attachments ?? []) content.push({ type: 'file', receiptId })
        for (const image of request.images ?? []) content.push({ type: 'image', data: image.data, mediaType: image.mediaType, ...(image.name === undefined ? {} : { name: image.name }) })
        await controller.prompt({ sessionId: request.sessionId, requestId: request.requestId, mode: 'queue', content }, signal)
        return { ...scope, kind: 'accepted', sessionId: request.sessionId }
      }
      case 'cancel': {
        controller.cancel({ sessionId: request.sessionId })
        return { ...scope, kind: 'cancelled', sessionId: request.sessionId }
      }
      /* v8 ignore next -- The wire parser accepts exactly these operation discriminants. */
      default: return assertNever(request)
    }
  }
}
