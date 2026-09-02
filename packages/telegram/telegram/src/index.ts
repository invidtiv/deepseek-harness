/**
 * Telegram forum topics as a native DeepSeek Harness frontend.
 *
 * One durable agent session per chat topic: the plugin long-polls the Bot
 * API, routes every authorized message in a topic to that topic's session
 * (creating, resuming, or refusing with precise errors), renders committed
 * assistant output back into the topic, and answers approvals and questions
 * through inline keyboards. The topic→session mapping is the plugin's own
 * storage-domain unit; session durability, workspace confinement, and
 * concurrency stay with the harness.
 * @module @deepseek-ai/dsh-telegram
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: the ctx.settings Context merge for the optional section install.
import type {} from '@deepseek-ai/dsh-settings'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AuthzGate } from './authz.ts'
import { HttpTelegramApi, isClosedTopic } from './bot.ts'
import type { TelegramApi } from './bot.ts'
import { CommandAdapter } from './commands.ts'
import { Config, MAX_DOCUMENT_BYTES } from './config.ts'
import { InteractionBridge } from './interactions.ts'
import { TopicRenderer } from './render.ts'
import { SessionManager } from './sessions.ts'
import type { TelegramAgentOptions } from './sessions.ts'
import { telegramTopicsDomain, topicKeyOf, TopicRegistry, sessionIdForKey } from './topics.ts'
import type { ChatTarget, TelegramDocument, TelegramMessage, TopicKey, Update } from './types.ts'
import { WorkspaceTopicBridge } from './workspace-topics.ts'
import { WorkspaceGuard } from './workspaces.ts'

export const name = 'telegram'
/** The plugin creates and owns agents; every other concern is carried by the agent composition (the ACP-bridge shape). */
export const inject = ['agents']

/**
 * Settings namespace the web Plugins configuration card binds. The section
 * schema is the plugin Config; while a settings service exists, the runtime
 * reads the resolved section instead of the composition entry.
 */
export const TELEGRAM_SETTINGS_NAMESPACE = 'telegram'

export { Config }
export type { Config as TelegramConfig }

/** In-memory dedupe window for update ids replayed across a crash-before-confirm restart. */
const UPDATE_DEDUPE_WINDOW = 1000

/** Map a downloaded Telegram photo path to an attachment media type. */
function mediaTypeOfFile(filePath: string): ImageMediaType {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    default:
      return 'image/jpeg'
  }
}

/** Reduce an untrusted Telegram filename to a basename with inoffensive characters. */
function sanitizeFileName(name: string | undefined, fallback: string): string {
  const leaf = basename((name ?? '').replaceAll('\\', '/'))
  const cleaned = leaf.replace(/[^\w.\- ]/gu, '_').trim().slice(0, 120)
  return cleaned === '' || cleaned === '.' ? fallback : cleaned
}

/** Value-equal comparison for two string arrays (workspace roots). */
function rootsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Mount the Telegram frontend. The plugin declares only `agents`; the peers
 * it cannot function without (`storageDomain`, `credentials`,
 * `sessionPersistence`) mount the runtime in a child fiber, mirroring the
 * storage-domain activation pattern, while everything else stays an optional
 * `ctx.get()` read.
 * @param ctx - Cordis context carrying the agent factory.
 * @param config - Validated plugin config (plus a test-only transport override).
 */
export function apply(ctx: Context, config: Config): void {
  const fiber = ctx.inject(['storageDomain', 'credentials', 'sessionPersistence'], (core) => {
    const runtime = new TelegramRuntime(core, config)
    const started = runtime.start().catch((error: unknown) => {
      core.logger.error(`telegram: startup failed: ${String(error)}`)
    })
    core.effect(() => {
      return async () => {
        await started
        await runtime.stop()
      }
    }, 'telegram.runtime')
  })
  void Promise.resolve(fiber).catch((error: unknown) => {
    ctx.logger.error(`telegram: activation failed: ${String(error)}`)
  })
}

/**
 * The whole plugin lifecycle. Constructed once per activation; every
 * registration, timer, poll, and live agent belongs to the activation fiber
 * and unwinds through {@link stop}.
 */
export class TelegramRuntime {
  private readonly abort = new AbortController()
  private readonly dedupe = new Set<number>()
  private api!: TelegramApi
  private poll: Promise<void> | undefined
  private authz: AuthzGate
  private registry!: TopicRegistry
  private sessions!: SessionManager
  private renderer!: TopicRenderer
  private interactions!: InteractionBridge
  private commands!: CommandAdapter
  private disposers: Array<() => void> = []
  private defaultWorkspaceCache: string | null | undefined = undefined
  private running = false
  private currentConfig: () => Config
  private guardState: { readonly roots: readonly string[]; readonly guard: Promise<WorkspaceGuard> } | undefined

  constructor(private readonly ctx: Context, private readonly config: Config) {
    // Misconfiguration fails loud at load: no allowlist side and no workspace
    // root means the bot could never admit (or fence) a single message.
    const chatList = config.allowedChatIds ?? []
    const userList = config.allowedUserIds ?? []
    if (chatList.length === 0 && userList.length === 0) {
      throw new Error('telegram: at least one of allowedChatIds or allowedUserIds must be configured')
    }
    const roots = config.workspaceRoots ?? []
    if (roots.length === 0) {
      throw new Error('telegram: workspaceRoots must list at least one allowed root directory')
    }
    if (config.workspaceTopicsChatId !== undefined && chatList.length > 0 && !chatList.includes(config.workspaceTopicsChatId)) {
      throw new Error('telegram: workspaceTopicsChatId must be listed in allowedChatIds')
    }
    this.authz = new AuthzGate(chatList, userList)
    this.currentConfig = () => config
  }

  /** Open the mapping domain, wire every module, and start long-polling. */
  async start(): Promise<void> {
    // The settings section lands before any state is built, so a stored user
    // layer already participates in the first guard, gate, and session. The
    // section base is the composition entry minus the runtime-only transport,
    // which settings describe/schema resolution must never carry (it is not
    // JSON and not part of the wire schema).
    const { transport: _transport, ...sectionBase } = this.config
    this.ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(this.ctx, TELEGRAM_SETTINGS_NAMESPACE, Config, sectionBase, {
        setSource: (source) => { this.currentConfig = source },
        onChange: () => { this.onSettingsCommitted() },
      })
    })
    this.api = this.currentConfig().transport
      ?? new HttpTelegramApi(() => this.resolveToken(), this.currentConfig().apiBase)
    const agents = this.ctx.agents
    const persistence = this.ctx.sessionPersistence

    await this.ensureGuard()
    if (this.currentConfig().defaultWorkspace !== undefined) {
      await (await this.ensureGuard()).select(this.currentConfig().defaultWorkspace as string)
    }
    const domain = await this.ctx.storageDomain.open(telegramTopicsDomain)
    this.ctx.effect(() => () => domain.close(), 'telegram.domain')
    this.registry = new TopicRegistry(domain)
    this.sessions = new SessionManager(
      agents,
      persistence,
      this.registry,
      this.renderAgentOptions.bind(this),
      this.ctx.logger,
    )
    const attachments = this.ctx.get('attachments')
    this.renderer = new TopicRenderer(
      this.api,
      attachments,
      this.renderEditInterval.bind(this),
      this.ctx.logger,
    )
    this.interactions = new InteractionBridge(
      this.api,
      agent => this.sessions.topicForAgent(agent)?.target,
      this.renderApprovalTimeout.bind(this),
      this.ctx.logger,
    )
    this.commands = new CommandAdapter(
      this.ctx,
      this.registry,
      this.sessions,
      () => this.ensureGuard(),
      this.ctx.logger,
    )

    // Output routing: session events and status transitions go back to the
    // owning topic; inbox claims maintain the per-topic pending counters.
    this.ctx.on('session/event', (session, event) => {
      const key = this.registry.keyOfSession(session.header.id)
      if (key === undefined) return
      const topic = this.sessions.byKey(key)
      if (topic === undefined) return
      this.renderer.onEvent(event, key, topic.target)
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      const topic = this.sessions.topicForAgent(agent)
      if (topic === undefined) return
      this.renderer.onStatus(status, topic.key, topic.target)
    })
    this.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      this.sessions.noteClaimed(agent, message.id)
    })
    this.ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      this.sessions.noteDiscarded(agent, message.id)
    })

    // Approval answers are one-shot buttons; anything else delegates on.
    this.ctx.on('approval/request', (request, next) => {
      const topic = this.sessions.topicForAgent(request.agent)
      if (topic === undefined) return next()
      return this.interactions.askApproval(request, topic.target)
    })

    const userQuestions = this.ctx.get('userQuestions')
    if (userQuestions !== undefined) {
      this.disposers.push(this.ctx.on('user-questions/request', this.interactions.questionsListener()))
    }
    const commandRuntime = this.ctx.get('commands')
    if (commandRuntime !== undefined) {
      this.disposers.push(...this.commands.register(commandRuntime))
    }

    // Workspace→topic creation observes the workspace domain in this process;
    // a configured chat without the registry is misconfiguration, not a
    // feature to skip silently.
    const workspaceRegistry = this.ctx.get('workspaceRegistry')
    if (this.currentConfig().workspaceTopicsChatId !== undefined && workspaceRegistry === undefined) {
      throw new Error('telegram: workspaceTopicsChatId requires the workspace registry (@deepseek-ai/dsh-workspace) in the composition')
    }
    if (workspaceRegistry !== undefined) {
      const bridge = new WorkspaceTopicBridge({
        api: () => this.api,
        registry: this.registry,
        workspaceById: id => workspaceRegistry.get(id),
        guard: () => this.ensureGuard(),
        config: () => this.currentConfig(),
        logger: this.ctx.logger,
      })
      this.ctx.on('domain/changed', (change) => { void bridge.onDomainChanged(change) })
    }

    this.poll = this.pollLoop()
    this.running = true
    this.ctx.logger.info('telegram: long-polling started')
  }

  /** Stop polling, settle interactions, dispose every live agent, unwind registrations. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort.abort(new Error('telegram plugin disposed'))
    if (this.poll !== undefined) {
      try {
        await this.poll
      } catch (error) {
        this.ctx.logger.warn(`telegram: poll loop exited with ${String(error)}`)
      }
    }
    for (const dispose of this.disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        this.ctx.logger.warn(`telegram: registration disposal failed: ${String(error)}`)
      }
    }
    this.disposers = []
    this.interactions.dispose()
    await this.sessions.disposeAll()
  }

  /** Resolve the bot token per operation through the credential seam. */
  private async resolveToken(): Promise<string> {
    const credentials = this.ctx.credentials
    const ref = (this.currentConfig().tokenRef ?? 'TELEGRAM_BOT_TOKEN') as CredentialRef
    const hit = await credentials.resolve(ref)
    if (hit === undefined) {
      throw new Error(`telegram: no credential for ${ref}; store it through the credentials service`)
    }
    return hit.value
  }

  /** The getUpdates loop: long-poll, dedupe, confirm offsets, dispatch. */
  private async pollLoop(): Promise<void> {
    let offset: number | undefined
    while (!this.abort.signal.aborted) {
      let updates: Update[]
      try {
        updates = await this.api.getUpdates(
          offset,
          this.abort.signal,
          Math.floor((this.currentConfig().pollTimeoutMs ?? 25_000) / 1000),
        )
      } catch (error) {
        if (!this.running) return
        this.ctx.logger.warn(`telegram: getUpdates failed: ${String(error)}`)
        await this.abortableDelay(1000)
        continue
      }
      for (const update of updates) {
        if (this.dedupe.has(update.update_id)) continue
        this.dedupe.add(update.update_id)
        if (this.dedupe.size > UPDATE_DEDUPE_WINDOW) {
          const oldest = this.dedupe.values().next().value as number
          this.dedupe.delete(oldest)
        }
        try {
          await this.handleUpdate(update)
        } catch (error) {
          this.ctx.logger.warn(`telegram: update ${update.update_id} failed: ${String(error)}`)
        }
        offset = update.update_id + 1
      }
    }
  }

  /** One authorized update: route by carrier, never by content. */
  private async handleUpdate(update: Update): Promise<void> {
    const decision = this.authz.allow(update)
    if (!decision.allowed) {
      this.ctx.logger.info(`telegram: update ${update.update_id} dropped: ${decision.reason}`)
      return
    }
    if (update.callback_query !== undefined) {
      await this.interactions.handleCallback(update.callback_query)
      return
    }
    const message = update.message
    if (message === undefined) return
    const key = topicKeyOf(message.chat.id, message.message_thread_id ?? null)
    const target: ChatTarget = { chatId: message.chat.id, threadId: message.message_thread_id ?? null }
    await this.handleMessage(key, target, message)
  }

  /** One authorized message: service events, commands, or model input. */
  private async handleMessage(key: TopicKey, target: ChatTarget, message: TelegramMessage): Promise<void> {
    if (message.forum_topic_created !== undefined) {
      await this.noteTopicTitle(key, message.forum_topic_created.name)
      return
    }
    if (message.forum_topic_closed !== undefined) {
      this.renderer.noteClosed(key)
      this.ctx.logger.info(`telegram: topic ${key} closed`)
      return
    }
    if (message.forum_topic_reopened !== undefined) {
      this.renderer.noteReopened(key)
      this.ctx.logger.info(`telegram: topic ${key} reopened`)
      return
    }
    if (message.photo !== undefined && message.photo.length > 0) {
      await this.handlePhoto(key, target, message.photo, message.caption)
      return
    }
    if (message.document !== undefined) {
      await this.handleDocument(key, target, message.document, message.message_id, message.caption)
      return
    }
    const text = message.text
    if (text === undefined || text.trim() === '') return
    const parsed = parseCommand(text)
    if (parsed !== undefined) {
      await this.handleCommand(key, target, text, parsed.name)
      return
    }
    await this.handleModelMessage(key, target, text)
  }

  /** A slash command: through the command runtime when a session exists, direct otherwise. */
  private async handleCommand(key: TopicKey, target: ChatTarget, line: string, name: string): Promise<void> {
    const topic = this.sessions.byKey(key)
    if (topic === undefined) {
      const direct = await this.commands.handleDirect(line, key)
      if (direct !== undefined) {
        await this.renderer.reply(target, direct)
        return
      }
      await this.renderer.reply(
        target,
        `Command /${name} needs a session. Send a message to start one, or choose a workspace with /folder.`,
      )
      return
    }
    const commandRuntime = this.ctx.get('commands')
    if (commandRuntime === undefined) {
      await this.renderer.reply(target, `Command /${name} is unavailable: the commands runtime is not mounted.`)
      return
    }
    try {
      const execution = await commandRuntime.execute(topic.agent, line, [], this.abort.signal)
      if (execution === undefined) {
        await this.renderer.reply(target, `Unknown command /${name}. Use /help to see available commands.`)
        return
      }
      await this.renderer.reply(target, execution.result.text ?? '')
    } catch (error) {
      await this.renderer.reply(target, `Command /${name} failed: ${String(error)}`)
    }
  }

  /** Ordinary text: admit into the topic session under the queue cap. */
  private async handleModelMessage(key: TopicKey, target: ChatTarget, text: string): Promise<void> {
    const resolution = await this.resolveSession(key)
    if (!resolution.ok) {
      await this.renderer.reply(target, resolution.reply)
      return
    }
    const topic = resolution.topic
    const pending = this.sessions.pendingCount(topic)
    if (pending >= (this.currentConfig().queueCap ?? 3)) {
      await this.renderer.reply(
        target,
        `Busy — ${pending} message(s) already queued. This one was not accepted (/cancel drops the queue).`,
      )
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    topic.agent.followup(message)
    this.sessions.noteSubmitted(topic, message.id)
  }

  /** Inbound photo: save through the attachment seam and follow up with an image block (plus caption when present). */
  private async handlePhoto(
    key: TopicKey,
    target: ChatTarget,
    photo: NonNullable<TelegramMessage['photo']>,
    caption?: string,
  ): Promise<void> {
    const capability = await this.imageCapability()
    const attachments = this.ctx.get('attachments')
    if (!capability || attachments === undefined) {
      await this.renderer.reply(target, 'Photos are not supported by this deployment (no image-capable model or attachment store).')
      return
    }
    const resolution = await this.resolveSession(key)
    if (!resolution.ok) {
      await this.renderer.reply(target, resolution.reply)
      return
    }
    const largest = photo[photo.length - 1] as NonNullable<TelegramMessage['photo']>[number]
    try {
      const file = await this.api.getFile(largest.file_id)
      if (file.file_path === undefined) {
        await this.renderer.reply(target, 'Could not download that photo.')
        return
      }
      const data = await this.api.downloadFile(file.file_path, this.abort.signal)
      const ref = await attachments.saveImage({
        data,
        mediaType: mediaTypeOfFile(file.file_path),
        name: `telegram-${largest.file_id}`,
      })
      const topic = resolution.topic
      const content: Array<{ type: 'image'; attachment: typeof ref } | { type: 'text'; text: string }> = [
        { type: 'image', attachment: ref },
      ]
      if (caption !== undefined && caption.trim() !== '') {
        content.push({ type: 'text', text: caption })
      }
      const message = createUserMessage({
        content,
        source: { kind: 'user' },
      })
      topic.agent.followup(message)
      this.sessions.noteSubmitted(topic, message.id)
    } catch (error) {
      await this.renderer.reply(target, `Photo ingestion failed: ${String(error)}`)
    }
  }

  /** Inbound document: download into the topic workspace's `_telegram_inbox` and reference it (caption forwarded when present). */
  private async handleDocument(
    key: TopicKey,
    target: ChatTarget,
    document: TelegramDocument,
    messageId: number,
    caption?: string,
  ): Promise<void> {
    if ((document.file_size ?? 0) > MAX_DOCUMENT_BYTES) {
      await this.renderer.reply(target, 'That document exceeds the 20 MB bot limit.')
      return
    }
    const resolution = await this.resolveSession(key)
    if (!resolution.ok) {
      await this.renderer.reply(target, resolution.reply)
      return
    }
    const row = this.registry.get(key)
    const workspace = row?.workspace
    if (workspace === undefined || workspace === null) {
      await this.renderer.reply(target, 'No workspace selected for this topic.')
      return
    }
    try {
      const file = await this.api.getFile(document.file_id)
      if (file.file_path === undefined) {
        await this.renderer.reply(target, 'Could not download that document.')
        return
      }
      const data = await this.api.downloadFile(file.file_path, this.abort.signal)
      const fileName = sanitizeFileName(document.file_name, `document-${messageId}`)
      const inboxDir = join(workspace, '_telegram_inbox')
      await mkdir(inboxDir, { recursive: true })
      const inboxPath = join(inboxDir, fileName)
      await writeFile(inboxPath, data)
      const relative = `_telegram_inbox/${fileName}`
      const topic = resolution.topic
      const parts = [`📎 Received document ${relative} (${data.byteLength} bytes).`]
      if (caption !== undefined && caption.trim() !== '') parts.push(caption)
      const message = createUserMessage({
        content: [{ type: 'text', text: parts.join('\n') }],
        source: { kind: 'user' },
      })
      topic.agent.followup(message)
      this.sessions.noteSubmitted(topic, message.id)
      await this.renderer.reply(target, `Saved ${relative}`)
    } catch (error) {
      await this.renderer.reply(target, `Document ingestion failed: ${String(error)}`)
    }
  }

  /** Resolve the topic session, supplying the default workspace upfront when the topic has no workspace yet. */
  private async resolveSession(key: TopicKey): Promise<ReturnType<SessionManager['resolve']>> {
    try {
      const record = this.registry.get(key)
      const hasWorkspace = record?.workspace !== undefined && record.workspace !== null
        || record?.pendingWorkspace !== undefined && record?.pendingWorkspace !== null
      if (hasWorkspace || record?.sessionId !== null && record?.sessionId !== undefined) {
        return await this.sessions.resolve(key)
      }
      const fallback = await this.defaultWorkspace()
      return await this.sessions.resolve(key, fallback)
    } catch (error) {
      return { ok: false, reply: `Session admission failed: ${String(error)}` }
    }
  }

  /** The validated default workspace — the configured one, else the sole root — resolved once and cached. */
  private async defaultWorkspace(): Promise<string | undefined> {
    if (this.defaultWorkspaceCache !== undefined) return this.defaultWorkspaceCache ?? undefined
    const guard = await this.ensureGuard()
    const configured = this.currentConfig().defaultWorkspace
    if (configured !== undefined) {
      try {
        this.defaultWorkspaceCache = await guard.select(configured)
      } catch (error) {
        this.ctx.logger.warn(`telegram: defaultWorkspace unusable: ${String(error)}`)
        this.defaultWorkspaceCache = null
      }
    } else if (guard.canonicalRoots.length === 1) {
      // Exactly one root leaves no selection to make: the bot uses it without prompting.
      this.defaultWorkspaceCache = guard.canonicalRoots[0] ?? null
    } else {
      this.defaultWorkspaceCache = null
    }
    return this.defaultWorkspaceCache ?? undefined
  }

  /** Provider/model selection for the session at admission, resolved live from the settings section. */
  private renderAgentOptions(): TelegramAgentOptions {
    return this.currentConfig().agentOptions ?? {}
  }

  /** Minimum placeholder-edit interval for one topic, resolved live from the settings section. */
  private renderEditInterval(): number {
    return this.currentConfig().editIntervalMs ?? 1000
  }

  /** Unanswered-prompt timeout, resolved live from the settings section. */
  private renderApprovalTimeout(): number {
    return this.currentConfig().approvalTimeoutMs ?? 600_000
  }

  /**
   * The canonical workspace guard for the roots currently in force. Rebuilt
   * once per settings commit (the resolved section's roots array identity is
   * the cache key); a commit that renamed the roots fails the next operation
   * loudly through the guard's own validation instead of guessing.
   * @returns the guard for the current roots.
   */
  private ensureGuard(): Promise<WorkspaceGuard> {
    const roots = this.currentConfig().workspaceRoots ?? []
    if (this.guardState !== undefined && rootsEqual(this.guardState.roots, roots)) return this.guardState.guard
    const guard = WorkspaceGuard.fromConfig(roots)
    this.guardState = { roots, guard }
    return guard
  }

  /**
   * Re-judge everything the plugin derived from configuration after a
   * settings commit: the authorization gate rebuilds synchronously, and the
   * workspace guard plus the default-workspace resolution invalidate so the
   * next admission rebuilds them against the committed section.
   */
  private onSettingsCommitted(): void {
    this.authz = new AuthzGate(
      this.currentConfig().allowedChatIds ?? [],
      this.currentConfig().allowedUserIds ?? [],
    )
    this.defaultWorkspaceCache = undefined
    this.guardState = undefined
    this.ctx.logger.info('telegram: settings section committed; authorization and workspace state rebuilt')
  }

  /** Record a topic's display name as metadata; never creates a session. */
  private async noteTopicTitle(key: TopicKey, title: string): Promise<void> {
    const row = this.registry.get(key)
    if (row === undefined) {
      const ref = TopicRegistry.parse(key)
      const now = new Date().toISOString()
      await this.registry.put(key, {
        chatId: ref.chatId,
        threadId: ref.threadId,
        sessionId: null,
        generation: 1,
        workspace: null,
        pendingWorkspace: null,
        topicTitle: title,
        createdAt: now,
        lastActivity: now,
      })
      return
    }
    await this.registry.update(key, current => ({ ...current, topicTitle: title, lastActivity: new Date().toISOString() }))
  }

  /** Whether the configured agent route declares image input (the ACP capability check). */
  private async imageCapability(): Promise<boolean> {
    const llm = this.ctx.get('llm')
    const provider = this.currentConfig().agentOptions?.provider
    const model = this.currentConfig().agentOptions?.model
    if (llm === undefined || provider === undefined || model === undefined) return false
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.inputModalities?.includes('image') === true
    } catch {
      return false
    }
  }

  /** Abortable backoff between poll failures. */
  private async abortableDelay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds)
      this.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('telegram plugin disposed'))
      }, { once: true })
    })
  }
}

// Re-exported vocabulary for tests and consumers.
export { isClosedTopic, HttpTelegramApi }
export type { TelegramApi }
export type { ChatTarget, TelegramDocument, TelegramMessage, TopicKey, Update }
export { sessionIdForKey, telegramTopicsDomain, topicKeyOf }
export type { SessionId }
