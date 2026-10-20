/**
 * Automation-only Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge exposes persistent harness sessions to trusted programmatic
 * clients. It carries standard configuration, MCP mounts, prompt content,
 * committed semantic updates, cancellation, and one-shot permission decisions;
 * presentation and human-interaction features stay with the harness's UI modules.
 *
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import {
  agent as createAcpAgentApp,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionConfigOption,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { supportsAcpImagePrompts } from './content.ts'
import { AcpMcpConfigError } from './mcp.ts'
import { AcpModelConfigError } from './model-control.ts'
import { v1Output, type AcpOutput } from './output.ts'
import { AcpSession } from './session.ts'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import * as v2Projection from './v2.ts'

const DEFAULT_SESSION_LIST_PAGE_SIZE = 100
const DEFAULT_SESSION_REPLAY_PAGE_SIZE = 256
/** Agent identity advertised on both protocol versions; the version is this package's. */
const AGENT_NAME = 'deepseek-harness-acp'
const AGENT_VERSION = packageVersion()

export const name = 'acp'
/** Core services required by the standard automation controls. */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions']

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number
  /** Negotiate draft ACP v2 alongside stable v1. */
  protocolV2?: boolean
  /** Maximum persisted events read per transcript replay page. */
  sessionReplayPageSize?: number
  /** Runtime-only transport override; production uses stdio. */
  stream?: v2.Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE),
  protocolV2: Schema.boolean().default(true),
  sessionReplayPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_REPLAY_PAGE_SIZE),
})

/**
 * Mount the automation-only ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const persistence = ctx.sessionPersistence
  const logger = ctx.logger
  const { sessionListPageSize, protocolV2, sessionReplayPageSize } = resolveConfig(config)
  const sessions = new Map<SessionId, AcpSession>()
  const activating = new Set<SessionId>()
  let closed = false
  let imagePromptEnabled = false
  let protocol: 1 | 2 = 1
  let conn: AgentContext
  let connV2: v2.AgentContext

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Parameters<AcpSession['owns']>[0]): AcpSession | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.owns(agent) === true ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): AcpSession => {
    if (activating.has(sessionId)) throw invalidParams(`session is activating: ${sessionId}`)
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Write one ordered update, containing a transport failure that connection teardown handles. */
  const contained = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write()
    /* v8 ignore start -- the ACP SDK contains notification-handler failures; only a transport write failure reaches this guard. */
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    }
    /* v8 ignore stop */
  }
  /** Delivery in the protocol negotiated by this connection. */
  const output = (sessionId: SessionId): AcpOutput => protocol === 2
    ? v2Projection.v2Output(ctx, sessionId, notification => contained(() => connV2.notify('session/update', notification)))
    : v1Output(ctx, sessionId, notification => contained(() => conn.notify(methods.client.session.update, notification)))

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record?.ownsSession(session) === true) record.onSessionEvent(session, event)
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    if (record === undefined) return
    record.onInboxClaimed(message, turn)
    // An admitted goal round changes the published round count.
    record.goalChanged()
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    ownedRecord(agent)?.onAgentError(turn, error)
  })

  ctx.on('commands/change', () => {
    for (const record of sessions.values()) record.commandsChanged()
  })

  ctx.on('goal/changed', ({ agent }) => { ownedRecord(agent)?.goalChanged() })
  // The payload carries only a session id, so ownership cannot be checked; the record
  // re-reads its own Agent's goal and publishes nothing when that state is unchanged.
  ctx.on('goal/activation-changed', ({ sessionId }) => { sessions.get(sessionId)?.goalChanged() })

  ctx.on('agent/status', ({ agent, status }) => { ownedRecord(agent)?.onStatus(status) })

  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) record.topologyChanged()
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    const options = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' as const },
    ]
    return record.withPermission(async () => {
      if (protocol === 2) {
        const { outcome } = await connV2.request('session/request_permission', {
          sessionId: record.agent.session.id,
          title: request.toolName,
          ...request.reason === undefined ? {} : { description: request.reason },
          subject: { type: 'tool_call', toolCall: { toolCallId: callId } },
          options,
        }, request.signal === undefined ? undefined : { cancellationSignal: request.signal })
        if (v2.RequestPermissionOutcome.isCancelled(outcome)) return 'cancelled'
        return v2.RequestPermissionOutcome.isSelected(outcome) && outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
      }
      const params: RequestPermissionRequest = { sessionId: record.agent.session.id, toolCall: { toolCallId: callId }, options }
      const { outcome } = await conn.request(methods.client.session.requestPermission, params)
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  /**
   * Restore a persisted session, optionally replay its history, and publish its progress.
   * The session stays activating until every restoration update is delivered, so no
   * request reaches it earlier; a failure closes it and leaves it resumable.
   * @param params - workspace and MCP mounts of the resume or load request.
   * @param signal - activation request cancellation.
   * @param replay - replay retained history before restoring progress.
   * @returns the restored record and its configuration options.
   */
  const activate = async (
    params: ResumeSessionRequest, signal: AbortSignal, replay: boolean,
  ): Promise<{ record: AcpSession; configOptions: SessionConfigOption[] }> => {
    assertOpen()
    validateWorkspaceParams(params)
    const sessionId = brandString<SessionId>(params.sessionId)
    if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
      throw invalidParams(`session is already active: ${sessionId}`)
    }
    activating.add(sessionId)
    try {
      const persisted = (await persistence.stat(sessionId, { signal }))?.header
      if (persisted === undefined || persisted.origin === 'subagent' || persisted.parentSession !== undefined) {
        throw invalidParams(`session is not resumable: ${sessionId}`)
      }
      if (!await sameDirectory(persisted.cwd, params.cwd)) {
        throw invalidParams(`session cwd does not match: ${params.cwd}`)
      }
      let record: AcpSession
      try {
        record = await AcpSession.resume(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
          agentOptions: agentOptions(config),
          fallbackSelection: initialSelection(config),
          signal,
          output,
        })
      } catch (error: unknown) {
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
        throw error
      }
      /* v8 ignore start -- the persisted header was checked before resume; the factory restores that exact header. */
      if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
        await record.close('session/resume cwd mismatch')
        throw invalidParams(`session cwd does not match: ${params.cwd}`)
      }
      /* v8 ignore stop */
      /* v8 ignore next 4 -- a real stdio close can race an in-flight resume. */
      if (closed) {
        await record.close('connection closed during session activation')
        throw internalError('connection closed during session activation')
      }
      sessions.set(sessionId, record)
      // The client already knows this session id, so v1 discovery precedes the response and any history.
      if (protocol === 1 && record.availableCommands().length > 0) record.commandsChanged()
      // Events committed before registration are replayed; later ones are delivered live behind the replay.
      const replayed = replay
        ? record.replay(async () => {
          await ctx.sessions.flush(record.agent.session)
          return persistence.open(sessionId, 'read', { signal })
        }, record.agent.session.seq, sessionReplayPageSize, signal)
        : undefined
      try {
        const configOptions = await record.configOptions(signal)
        await replayed
        // Replayed history already carries the standing plan; the goal has no durable projection.
        await record.restoreProgress({ plan: !replay })
        await record.announceIdle()
        return { record, configOptions }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session activation failed')
        throw error
      }
    } finally {
      activating.delete(sessionId)
    }
  }

  const implementation = {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      }
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      return Promise.resolve()
    },

    async newSession(
      params: NewSessionRequest, signal: AbortSignal,
    ): Promise<NewSessionResponse & { configOptions: SessionConfigOption[] }> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(randomUUID())
      // No preset composition: the ACP bundle keeps the model-facing rows in
      // the host plane, so this agent reads them from the global layer. A
      // deployment that configures a roster has to join one here first
      // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
      let record: AcpSession
      try {
        record = await AcpSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          agentOptions: agentOptions(config),
          fallbackSelection: initialSelection(config),
          signal,
          output,
        })
      } catch (error: unknown) {
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
        throw error
      }
      /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
      if (closed) {
        await record.close('connection closed during session/new')
        throw internalError('connection closed during session/new')
      }
      sessions.set(sessionId, record)
      try {
        const configOptions = await record.configOptions(signal)
        assertOpen()
        // The attached log writer's flush materializes an empty session durably.
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        return { sessionId, configOptions }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session/new activation failed')
        throw error
      }
    },

    async resumeSession(
      params: ResumeSessionRequest, signal: AbortSignal,
    ): Promise<ResumeSessionResponse & { configOptions: SessionConfigOption[] }> {
      const { configOptions } = await activate(params, signal, false)
      return { configOptions }
    },

    async loadSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<LoadSessionResponse> {
      const { configOptions } = await activate(params, signal, true)
      return { configOptions }
    },

    async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
      assertOpen()
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }
      let cursor: SessionListCursor | undefined
      try {
        cursor = decodeSessionListCursor(params.cursor)
      } catch (error: unknown) {
        throw invalidParams((error as Error).message)
      }
      const listed = await persistence.list({ signal })
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (
          sessions.has(header.id)
            || activating.has(header.id)
            || ctx.sessions.get(header.id) !== undefined
            || header.origin === 'subagent'
            || header.parentSession !== undefined
            || header.cwd === undefined
            || !isAbsolute(header.cwd)
        ) return undefined
        if (params.cwd !== undefined && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return undefined
        }
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt }
      }))
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId))
      const remaining = cursor === undefined
        ? entries
        : entries.filter(entry => isAfterSessionListCursor(entry, cursor))
      const page = remaining.slice(0, sessionListPageSize)
      const next = remaining.length > page.length ? page.at(-1) : undefined
      return {
        sessions: page.map(({ sessionId, cwd }) => ({ sessionId, cwd })),
        ...next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) },
      }
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) }
      } catch (error: unknown) {
        if (error instanceof AcpModelConfigError) throw invalidParams(error.message)
        throw error
      }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      assertOpen()
      const sessionId = brandString<SessionId>(params.sessionId)
      const record = requireSession(sessionId)
      try {
        await record.close('ACP session closed')
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
      }
      return {}
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      return record.prompt(params, imagePromptEnabled, requestSignal)
    },

    cancel(params: CancelNotification): Promise<void> {
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel()
      return Promise.resolve()
    },
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: v2.Stream = config.stream ?? v2.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  const app = createAcpAgentApp({ name: AGENT_NAME })
    .onConnect((connection) => { conn = connection.client })
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params)
      return {}
    })
    .onRequest(methods.agent.session.new, async ({ params, signal }) => {
      const result = await implementation.newSession(params, signal)
      const record = sessions.get(brandString<SessionId>(result.sessionId))
      // The client learns the session id from this response; the SDK writes the response
      // before any later macrotask, so command discovery follows it on the wire.
      if (record !== undefined && record.availableCommands().length > 0) setImmediate(() => { record.commandsChanged() })
      return result
    })
    .onRequest(methods.agent.session.load, ({ params, signal }) => implementation.loadSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  const appV2 = v2.agent({ name: AGENT_NAME })
    .onConnect((connection) => { protocol = 2; connV2 = connection.client })
    .onRequest('initialize', async () => {
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
      return {
        protocolVersion: 2,
        info: { name: AGENT_NAME, version: AGENT_VERSION },
        capabilities: { session: {
          mcp: { stdio: {}, http: {} },
          prompt: imagePromptEnabled ? { image: {} } : {},
        } },
        authMethods: [],
      }
    })
    .onRequest('session/new', async ({ params, signal }) => {
      const result = await implementation.newSession({ ...params, mcpServers: v2Projection.mcpServers(params.mcpServers) }, signal)
      return { sessionId: result.sessionId, configOptions: v2Projection.configOptions(result.configOptions),
        availableCommands: v2Projection.availableCommands(requireSession(brandString<SessionId>(result.sessionId)).availableCommands()),
      }
    })
    .onRequest('session/list', ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest('session/resume', async ({ params, signal }) => {
      if (params.replayFrom != null && !v2.ReplayFrom.isStart(params.replayFrom)) throw invalidParams('unsupported replay cursor')
      const { record, configOptions } = await activate(
        { ...params, mcpServers: v2Projection.mcpServers(params.mcpServers) }, signal, params.replayFrom != null,
      )
      return { configOptions: v2Projection.configOptions(configOptions),
        availableCommands: v2Projection.availableCommands(record.availableCommands()),
      }
    })
    .onRequest('session/close', ({ params }) => implementation.closeSession(params))
    .onRequest('session/set_config_option', async ({ params, signal }) => {
      if (!v2.SetSessionConfigOptionRequest.isId(params)) throw invalidParams('unsupported configuration option type')
      const result = await implementation.setSessionConfigOption(params, signal)
      return { configOptions: v2Projection.configOptions(result.configOptions) }
    })
    .onRequest('session/prompt', ({ params, signal }) => {
      assertOpen()
      return requireSession(brandString<SessionId>(params.sessionId)).promptAccepted(
        { sessionId: params.sessionId, prompt: v2Projection.promptContent(params.prompt) }, imagePromptEnabled, signal,
      ).then(messageId => ({ messageId }))
    })
    .onNotification('session/cancel', ({ params }) => implementation.cancel(params))
  const router = v2.agentProtocolRouter().withV1(app)
  if (protocolV2) router.withV2(appV2)
  const connection = protocolV2 ? router.connect(stream) : app.connect(stream as Stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    // AcpSession.close cancels synchronously before its first await, so every owned
    // prompt stops before any descendant or persistence drain can block.
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.close('ACP bridge disposed')))
      for (const record of records) {
        /* v8 ignore next -- closed blocks concurrent handlers; each captured record remains mapped until this loop. */
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id)
      }
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

/** Read this package's version in both source and bundled installations. */
function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: unknown }
  /* v8 ignore next -- the workspace manifest always carries a version; this guards a corrupt installation. */
  if (typeof manifest.version !== 'string') throw new Error('acp: package.json has no version')
  return manifest.version
}

/** Initial session selection when both deployment fields are present. */
function initialSelection(config: AcpConfig): ModelSelection | undefined {
  return config.provider === undefined || config.model === undefined
    ? undefined
    : { provider: config.provider, model: config.model }
}

interface SessionListCursor {
  createdAt: number
  sessionId: string
}

/** Deployment choices after defaulting. */
interface AcpSpec {
  sessionListPageSize: number
  protocolV2: boolean
  sessionReplayPageSize: number
}

/**
 * Resolve the deployment choices shared by every session of this connection.
 * Cordis applies the Config schema; direct `apply` callers receive the same defaults here.
 * @param config - plugin configuration.
 * @returns the defaulted, validated choices.
 */
function resolveConfig(config: AcpConfig): AcpSpec {
  const spec = {
    sessionListPageSize: config.sessionListPageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE,
    protocolV2: config.protocolV2 ?? true,
    sessionReplayPageSize: config.sessionReplayPageSize ?? DEFAULT_SESSION_REPLAY_PAGE_SIZE,
  }
  for (const key of ['sessionListPageSize', 'sessionReplayPageSize'] as const) {
    /* v8 ignore next -- Cordis applies the positive-integer Config schema; this protects direct apply callers. */
    if (!Number.isSafeInteger(spec[key]) || spec[key] < 1) throw new Error(`acp: ${key} must be a positive safe integer`)
  }
  return spec
}

/** Decode an opaque keyset cursor without assigning meaning to client metadata. */
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  if (value === undefined || value === null) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('session/list cursor is invalid')
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
    ) throw new Error('invalid cursor fields')
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical cursor')
    return { createdAt, sessionId }
  } catch (_invalidCursor) {
    throw new Error('session/list cursor is invalid')
  }
}

/** Encode the last returned ordering key as an opaque continuation token. */
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** Test whether an entry follows the cursor in newest-first list order. */
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return entry.createdAt < cursor.createdAt
    || (entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
}

/** Compare opaque session ids by stable UTF-8 bytes, independent of process locale. */
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** Reject workspace features outside the automation contract. */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] | null }): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    params.additionalDirectories !== undefined
    && params.additionalDirectories !== null
    && params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/** Compare existing directories by physical identity and missing paths lexically. */
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch (_unresolvablePath) {
    return resolve(left) === resolve(right)
  }
}
