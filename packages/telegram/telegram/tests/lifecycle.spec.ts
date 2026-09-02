import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TelegramRuntime } from '../src/index.ts'
import {
  ALLOWED_USER,
  GENERAL_TOPIC,
  makeTelegramHarness,
  textResponse,
  textUpdate,
  type TelegramHarness,
} from './harness.ts'

function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 8000, interval: 25 })
}

function settled(milliseconds = 150): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds))
}

describe('Telegram plugin activation', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    vi.unstubAllGlobals()
  })

  it('refuses a runtime with no allowlist and one with no workspace root', async () => {
    harness = await makeTelegramHarness({ mountPlugin: false })
    const ctx = harness.ctx
    const root = harness.roots[0] as string
    expect(() => new TelegramRuntime(ctx, { workspaceRoots: [root] }))
      .toThrow(/at least one of allowedChatIds or allowedUserIds/u)
    expect(() => new TelegramRuntime(ctx, { allowedChatIds: [], allowedUserIds: [], workspaceRoots: [root] }))
      .toThrow(/at least one of allowedChatIds or allowedUserIds/u)
    expect(() => new TelegramRuntime(ctx, { allowedUserIds: [ALLOWED_USER] }))
      .toThrow(/workspaceRoots must list at least one allowed root directory/u)
    expect(() => new TelegramRuntime(ctx, { allowedChatIds: [GENERAL_TOPIC.chatId], workspaceRoots: [] }))
      .toThrow(/workspaceRoots must list at least one allowed root directory/u)
    expect(new TelegramRuntime(ctx, { allowedUserIds: [ALLOWED_USER], workspaceRoots: [root] }))
      .toBeInstanceOf(TelegramRuntime)
  })

  it('logs an activation failure instead of failing the mount', async () => {
    harness = await makeTelegramHarness({ config: { allowedChatIds: [], allowedUserIds: [] } })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await settled()
    expect(harness.api.sent).toHaveLength(0)
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('logs a startup failure when the default workspace is outside every root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'telegram-outside-'))
    harness = await makeTelegramHarness({ config: { defaultWorkspace: outside } })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await settled()
    expect(harness.api.sent).toHaveLength(0)
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })
})

describe('Telegram HTTP transport', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    vi.unstubAllGlobals()
  })

  it('long-polls and answers over the Bot API with the resolved token', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    let polled = false
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/getUpdates')) {
        if (polled) {
          // Every later poll stays open until the plugin aborts it.
          return await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        }
        polled = true
        return new Response(JSON.stringify({
          ok: true,
          result: [textUpdate(1, GENERAL_TOPIC, 'hello over http')],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      posts.push({ url, body: init.body })
      return new Response(JSON.stringify({ ok: true, result: { message_id: posts.length, chat: { id: GENERAL_TOPIC.chatId } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    harness = await makeTelegramHarness({
      script: [textResponse('answered over http')],
      omitConfig: ['transport', 'tokenRef'],
      config: { apiBase: 'http://telegram.test' },
    })
    await waitFor(() => {
      expect(posts.some(post => String(post.body).includes('answered over http'))).toBe(true)
    })
    expect(posts[0]?.url).toBe('http://telegram.test/bottest-token/sendMessage')
  }, 20000)

  it('backs off without calling the Bot API when the token cannot be resolved', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: unknown): Promise<Response> => {
      requests.push(String(input))
      return new Response('{}', { status: 200 })
    })
    harness = await makeTelegramHarness({
      omitConfig: ['transport'],
      config: { tokenRef: 'TELEGRAM_MISSING_TOKEN' },
    })
    // Two poll attempts and the backoff between them happen without a request.
    await settled(1200)
    expect(requests).toHaveLength(0)
  }, 20000)
})

describe('Telegram runtime routing of foreign sessions', () => {
  let harness: TelegramHarness | undefined
  let second: TelegramHarness | undefined

  afterEach(async () => {
    await second?.dispose()
    await harness?.dispose()
    harness = undefined
    second = undefined
  })

  it('ignores session events, status changes, and approvals of unowned agents', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('mine')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('mine')
    })
    const sessionId = (harness.ctx.agents.list()[0] as Agent).session.id
    const { storageRoot, persistenceRoot, roots } = harness
    const postedByTopic = harness.api.texts().length
    await harness.dispose()
    harness = undefined

    // A restart maps the session without reviving it; a session resumed
    // outside the plugin therefore produces events the plugin must ignore.
    second = await makeTelegramHarness({ storageRoot, persistenceRoot, workspaceRoots: roots, script: ['hang'] })
    await second.api.waitForPoll()
    const mapped = await second.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const unmapped = await second.ctx.agents.create({
      sessionId: 'telegram-foreign-session' as Agent['session']['id'],
      meta: { cwd: roots[0] as string },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    mapped.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'outside' }], source: { kind: 'user' } }))
    await waitFor(() => {
      expect(second?.adapter.requests ?? []).toHaveLength(1)
    })
    // A command on the unmapped session logs events no topic can own.
    const help = await second.ctx.commands.execute(unmapped.agent, '/help', [], new AbortController().signal)
    expect(help?.result.text).toContain('/status')
    await expect(second.ctx.approval.request({ agent: mapped.agent, toolName: 'bash' })).resolves.toBe('unavailable')
    await settled()
    expect(second.api.texts()).toHaveLength(0)
    expect(postedByTopic).toBeGreaterThan(0)
    mapped.agent.cancel({ kind: 'user' })
    await unmapped.dispose()
    await mapped.dispose()
  }, 30000)
})
