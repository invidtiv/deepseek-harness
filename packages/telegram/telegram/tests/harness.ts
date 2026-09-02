/** In-memory Telegram transport and real-service harness for plugin tests. */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { type GenerateOptions, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { credentialRef, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as TelegramPlugin from '../src/index.ts'
import type { Config, TelegramApi } from '../src/index.ts'
import type { InlineKeyboard, SentMessage, TelegramFile, Update } from '../src/types.ts'
import { TelegramApiError } from '../src/bot.ts'

/** Scripted adapter for protocol tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: (StreamChunk[] | 'hang')[],
    private readonly imageCapable: boolean,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== 'mock') throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: 'mock', name: 'Mock' }
  }

  override listModels(provider: string) {
    return Promise.resolve(provider === 'mock' ? [{
      provider: 'mock',
      id: 'mock',
      name: 'Mock',
      inputModalities: this.imageCapable ? ['text', 'image'] as const : ['text'] as const,
    }] : [])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.imageCapable ? ['text', 'image'] : ['text'],
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** In-memory attachment store for photo round trips. */
class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly saved: SaveImageAttachment[] = []
  readonly objects = new Map<string, StoredImageAttachment>()

  async validateImage(input: SaveImageAttachment): Promise<void> {
    if (input.data.byteLength === 0) throw new Error('empty image')
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${digest}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.objects.set(ref.attachmentId, { ref, data: Uint8Array.from(input.data) })
    return Promise.resolve(ref)
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const stored = this.objects.get(ref.attachmentId)
    if (stored === undefined) throw new Error('missing attachment')
    return { ref: stored.ref, data: Uint8Array.from(stored.data) }
  }
}

/** Fixed-value credential provider. */
class MemoryCredentials extends CredentialProvider {
  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (ref === credentialRef('TELEGRAM_BOT_TOKEN')) return { value: 'test-token', source: 'env' }
    return undefined
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const resolved = await this.resolve(ref)
    return resolved === undefined ? { configured: false, writable: true } : { configured: true, source: resolved.source, writable: true }
  }

  set(_ref: CredentialRef, _value: string): Promise<void> {
    throw new Error('not implemented in tests')
  }

  unset(_ref: CredentialRef): Promise<void> {
    throw new Error('not implemented in tests')
  }

  readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    throw new Error('not implemented in tests')
  }

  deleteRecord(_key: CredentialKey): Promise<void> {
    throw new Error('not implemented in tests')
  }
}

/**
 * Controllable in-memory Bot API: tests push updates into a queue and read
 * every outbound call off a log. `getUpdates` blocks until an update arrives
 * or the plugin aborts.
 */
class FakeTelegramApi implements TelegramApi {
  readonly sent: RecordedSend[] = []
  private pending: Update[] = []
  private waiters: Array<() => void> = []
  private readonly polled = Promise.withResolvers<undefined>()
  private polledOnce = false
  private messageSeq = 0
  private failWith: Error | undefined
  private failDownloadWith: Error | undefined
  private readonly files = new Map<string, { path: string; bytes: Uint8Array }>()

  /** Next outbound call throws this (for closed-topic simulation); one-shot. */
  failNext(error: Error): void {
    this.failWith = error
  }

  /** Next file download throws this; one-shot. */
  failNextDownload(error: Error): void {
    this.failDownloadWith = error
  }

  /** Register a downloadable file for getFile/downloadFile. */
  registerFile(fileId: string, path: string, bytes: Uint8Array): void {
    this.files.set(fileId, { path, bytes })
  }

  /** Resolves once the first getUpdates long-poll arrives. */
  waitForPoll(): Promise<void> {
    return this.polled.promise
  }

  /** Push one update into the poll queue. */
  push(update: Update): void {
    this.pending.push(update)
    for (const wake of this.waiters.splice(0)) wake()
  }

  /** All recorded outbound sends, oldest first. */
  texts(): string[] {
    return this.sent.map(send => send.text).filter((text): text is string => text !== undefined)
  }

  /** The latest keyboard recorded on any outbound call. */
  latestKeyboard(): InlineKeyboard | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const markup = this.sent[index]?.replyMarkup
      if (markup !== undefined) return markup
    }
    return undefined
  }

  async createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }> {
    this.throwIfFailing()
    const threadId = 500 + this.sent.filter(send => send.method === 'createForumTopic').length
    this.sent.push({ method: 'createForumTopic', target: { chatId, threadId }, text: name })
    return { message_thread_id: threadId, name }
  }

  async getUpdates(_offset: number | undefined, signal: AbortSignal, _timeoutSeconds: number): Promise<Update[]> {
    if (!this.polledOnce) {
      this.polledOnce = true
      this.polled.resolve(undefined)
    }
    for (;;) {
      if (this.pending.length > 0) return this.pending.splice(0)
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => { resolve() }
        this.waiters.push(wake)
        signal.addEventListener('abort', () => {
          const at = this.waiters.indexOf(wake)
          if (at >= 0) this.waiters.splice(at, 1)
          reject(new Error('aborted'))
        }, { once: true })
      })
    }
  }

  async sendMessage(target: { chatId: number; threadId: number | null }, text: string, options?: { parseMode?: 'HTML' | 'MarkdownV2'; replyMarkup?: InlineKeyboard }): Promise<SentMessage> {
    this.throwIfFailing()
    this.sent.push({ method: 'sendMessage', target, text, ...options?.replyMarkup !== undefined ? { replyMarkup: options.replyMarkup } : {} })
    return { message_id: ++this.messageSeq, chat: { id: target.chatId } }
  }

  async editMessageText(target: { chatId: number; threadId: number | null }, messageId: number, text: string, _options?: { parseMode?: 'HTML' | 'MarkdownV2'; replyMarkup?: InlineKeyboard }): Promise<SentMessage> {
    this.throwIfFailing()
    this.sent.push({ method: 'editMessageText', target, text, messageId })
    return { message_id: messageId, chat: { id: target.chatId } }
  }

  async deleteMessage(target: { chatId: number; threadId: number | null }, messageId: number): Promise<void> {
    this.throwIfFailing()
    this.sent.push({ method: 'deleteMessage', target, messageId })
  }

  async sendPhoto(target: { chatId: number; threadId: number | null }, data: Uint8Array): Promise<SentMessage> {
    this.throwIfFailing()
    this.sent.push({ method: 'sendPhoto', target, photoBytes: data.byteLength })
    return { message_id: ++this.messageSeq, chat: { id: target.chatId } }
  }

  async sendDocument(target: { chatId: number; threadId: number | null }, _data: Uint8Array, filename: string): Promise<SentMessage> {
    this.throwIfFailing()
    this.sent.push({ method: 'sendDocument', target, documentName: filename })
    return { message_id: ++this.messageSeq, chat: { id: target.chatId } }
  }

  async answerCallbackQuery(callbackId: string): Promise<void> {
    this.sent.push({ method: 'answerCallbackQuery', target: { chatId: 0, threadId: null }, text: callbackId })
  }

  async removeInlineKeyboard(target: { chatId: number; threadId: number | null }, messageId: number): Promise<SentMessage> {
    this.sent.push({ method: 'removeInlineKeyboard', target, messageId })
    return { message_id: messageId, chat: { id: target.chatId } }
  }

  async editInlineKeyboard(
    target: { chatId: number; threadId: number | null },
    messageId: number,
    replyMarkup: InlineKeyboard,
  ): Promise<SentMessage> {
    this.sent.push({ method: 'editInlineKeyboard', target, messageId, replyMarkup })
    return { message_id: messageId, chat: { id: target.chatId } }
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    const file = this.files.get(fileId)
    if (file === undefined) return { file_id: fileId }
    return { file_id: fileId, file_path: file.path, file_size: file.bytes.byteLength }
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    if (this.failDownloadWith !== undefined) {
      const failure = this.failDownloadWith
      this.failDownloadWith = undefined
      throw failure
    }
    for (const file of this.files.values()) {
      if (file.path === filePath) return Uint8Array.from(file.bytes)
    }
    throw new TelegramApiError('file not found', 404, undefined)
  }

  private throwIfFailing(): void {
    if (this.failWith !== undefined) {
      const failure = this.failWith
      this.failWith = undefined
      throw failure
    }
  }
}

/** One chat/topic pair addressed by a test. */
export interface TestTopic {
  readonly chatId: number
  readonly threadId: number | null
}

export const GENERAL_TOPIC: TestTopic = { chatId: 1001, threadId: null }
export const FORUM_TOPIC: TestTopic = { chatId: 1001, threadId: 42 }
export const ALLOWED_USER = 7001

/** An inbound text update from one topic. */
export function textUpdate(updateId: number, topic: TestTopic, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: topic.chatId, type: 'supergroup', is_forum: true },
      ...topic.threadId !== null ? { message_thread_id: topic.threadId } : {},
      from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
      text,
    },
  }
}

/** An inbound photo update with a registered downloadable file and an optional caption. */
export function photoUpdate(updateId: number, topic: TestTopic, fileId: string, caption?: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: topic.chatId, type: 'supergroup', is_forum: true },
      ...topic.threadId !== null ? { message_thread_id: topic.threadId } : {},
      from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
      photo: [{ file_id: fileId, file_unique_id: fileId, width: 1, height: 1 }],
      ...caption !== undefined ? { caption } : {},
    },
  }
}

/** An inbound document update with an optional caption. */
export function documentUpdate(updateId: number, topic: TestTopic, fileId: string, name: string, caption?: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: topic.chatId, type: 'supergroup', is_forum: true },
      ...topic.threadId !== null ? { message_thread_id: topic.threadId } : {},
      from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
      document: { file_id: fileId, file_unique_id: fileId, file_name: name, file_size: 10 },
      ...caption !== undefined ? { caption } : {},
    },
  }
}

/** A callback-button press update addressed to a prompt message. */
export function callbackUpdate(updateId: number, data: string, topic: TestTopic = GENERAL_TOPIC): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
      message: {
        message_id: updateId,
        chat: { id: topic.chatId },
        ...topic.threadId !== null ? { message_thread_id: topic.threadId } : {},
      },
      data,
    },
  }
}

/** A forum topic-created service update. */
export function topicCreatedUpdate(updateId: number, topic: TestTopic, name: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: topic.chatId, type: 'supergroup', is_forum: true },
      ...topic.threadId !== null ? { message_thread_id: topic.threadId } : {},
      from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
      forum_topic_created: { name, icon_color: 1 },
    },
  }
}

/** One recorded outbound send, for assertions. */
interface RecordedSend {
  readonly method: string
  readonly target: { chatId: number; threadId: number | null }
  readonly text?: string
  readonly messageId?: number
  readonly replyMarkup?: InlineKeyboard
  readonly photoBytes?: number
  readonly documentName?: string
}

export interface TelegramHarness {
  ctx: Context
  api: TelegramApi & {
    readonly sent: RecordedSend[]
    texts(): string[]
    latestKeyboard(): InlineKeyboard | undefined
    push(update: Update): void
    waitForPoll(): Promise<void>
    registerFile(fileId: string, path: string, bytes: Uint8Array): void
    failNext(error: Error): void
    failNextDownload(error: Error): void
  }
  adapter: LlmAdapter & { readonly requests: GenerateOptions[] }
  workspaces: WorkspaceRegistry | undefined
  attachments: (AttachmentStore & { readonly saved: SaveImageAttachment[] }) | undefined
  roots: string[]
  persistenceRoot: string
  storageRoot: string
  config: Config
  settings: FileSettingsProvider | undefined
  pluginFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  dispose: () => Promise<void>
}

/**
 * Mount the real service tree the plugin depends on (agent loop with a
 * scripted adapter, storage domain, JSONL persistence, credentials, commands,
 * approval, questions, optional attachments), then mount the plugin with an
 * in-memory transport.
 */
export async function makeTelegramHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: Partial<Config>
  imageCapable?: boolean
  attachments?: boolean
  workspaceRoots?: string[]
  mountPlugin?: boolean
  settings?: boolean
  storageRoot?: string
  persistenceRoot?: string
  commands?: boolean
  userQuestions?: boolean
  workspaceRegistry?: boolean
  omitConfig?: ReadonlyArray<keyof Config>
} = {}): Promise<TelegramHarness> {
  const adapter = new MockAdapter(options.script ?? [], options.imageCapable === true)
  const api = new FakeTelegramApi()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  // The agent loop declares sessionProjections a required injection: mount the
  // registry before the loop activates (the acp harness shape).
  await ctx.plugin(SessionProjectionRegistry)
  if (options.attachments === true) await ctx.plugin(MemoryAttachmentStore)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)

  const storageRoot = options.storageRoot ?? await mkdtemp(join(tmpdir(), 'telegram-storage-'))
  const persistenceRoot = options.persistenceRoot ?? await mkdtemp(join(tmpdir(), 'telegram-sessions-'))
  await ctx.plugin(Storage)
  await ctx.plugin({ ...StorageJson, name: 'storage-json' }, { root: storageRoot })
  await ctx.plugin({ ...StorageDomain, name: 'storage-domain' }, { backend: 'json' })
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
  await ctx.plugin(MemoryCredentials)
  if (options.commands !== false) await ctx.plugin(CommandRuntime)
  if (options.userQuestions !== false) await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService)
  if (options.workspaceRegistry === true) await ctx.plugin(WorkspaceRegistry)
  if (options.settings === true) {
    const settingsPath = join(await mkdtemp(join(tmpdir(), 'telegram-settings-')), 'settings.yaml')
    await ctx.plugin(FileSettingsProvider, { path: settingsPath })
  }

  const roots = options.workspaceRoots ?? [await mkdtemp(join(tmpdir(), 'telegram-root-'))]
  const config: Config = {
    tokenRef: 'TELEGRAM_BOT_TOKEN',
    allowedChatIds: [GENERAL_TOPIC.chatId, FORUM_TOPIC.chatId],
    allowedUserIds: [ALLOWED_USER],
    workspaceRoots: roots,
    pollTimeoutMs: 1000,
    editIntervalMs: 250,
    approvalTimeoutMs: 5000,
    queueCap: 3,
    agentOptions: { provider: 'mock', model: 'mock' },
    transport: api,
    ...options.config,
  }
  for (const key of options.omitConfig ?? []) Reflect.deleteProperty(config, key)
  let pluginFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  if (options.mountPlugin !== false) {
    pluginFiber = await ctx.plugin({
      name: 'telegram-test',
      inject: [...TelegramPlugin.inject],
      apply: (inner: Context) => { TelegramPlugin.apply(inner, config) },
    })
  }

  return {
    ctx,
    api,
    adapter,
    workspaces: ctx.get('workspaceRegistry'),
    attachments: ctx.get('attachments') as MemoryAttachmentStore | undefined,
    roots,
    persistenceRoot,
    storageRoot,
    config,
    settings: ctx.get('settings') as FileSettingsProvider | undefined,
    pluginFiber,
    dispose: async () => {
      await ctx.fiber.dispose()
    },
  }
}
