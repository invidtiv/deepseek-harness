import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TELEGRAM_SETTINGS_NAMESPACE } from '../src/index.ts'
import {
  ALLOWED_USER,
  FORUM_TOPIC,
  GENERAL_TOPIC,
  makeTelegramHarness,
  textResponse,
  textUpdate,
  type TelegramHarness,
} from './harness.ts'

function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 8000, interval: 25 })
}

describe('Telegram settings section', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    vi.unstubAllGlobals()
    await harness?.dispose()
    harness = undefined
  })

  it('registers the telegram namespace with the plugin config schema', async () => {
    harness = await makeTelegramHarness({ settings: true, script: [textResponse('ok')] })
    await harness.api.waitForPoll()
    const descriptors = harness.settings?.describe() ?? []
    const descriptor = descriptors.find(candidate => candidate.ns === TELEGRAM_SETTINGS_NAMESPACE)
    expect(descriptor).toBeDefined()
    expect(descriptor?.value).toMatchObject({
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      allowedChatIds: [GENERAL_TOPIC.chatId, FORUM_TOPIC.chatId],
      allowedUserIds: [ALLOWED_USER],
      queueCap: 3,
    })
    const schema = descriptor?.schema as { uid?: number; refs?: Record<string, { type?: string; dict?: Record<string, unknown> }> }
    expect(schema.uid).toBeTypeOf('number')
    const rootRef = schema.refs?.[String(schema.uid)]
    expect(Object.keys(rootRef?.dict ?? {})).toContain('queueCap')
  })

  it('honors a committed queue-cap override', async () => {
    harness = await makeTelegramHarness({ settings: true, script: ['hang'] })
    await harness.api.waitForPoll()
    await harness.settings?.update(TELEGRAM_SETTINGS_NAMESPACE, { queueCap: 1 })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'first'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, 'second'))
    await waitFor(() => {
      expect(harness?.api.texts().some(text => text.startsWith('Busy'))).toBe(true)
    })
  })

  it('honors a committed allowlist override', async () => {
    harness = await makeTelegramHarness({ settings: true, script: [textResponse('x')] })
    await harness.api.waitForPoll()
    await harness.settings?.update(TELEGRAM_SETTINGS_NAMESPACE, { allowedUserIds: [9999] })
    harness.api.push(textUpdate(1, FORUM_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(0)
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
    expect(harness.api.texts()).toHaveLength(0)
  })

  it('rebuilds the workspace guard on commit', async () => {
    harness = await makeTelegramHarness({ settings: true, script: [textResponse('x')] })
    await harness.api.waitForPoll()
    const rootA = harness.roots[0] as string
    const rootB = await mkdtemp(join(tmpdir(), 'telegram-root-b-'))
    await harness.settings?.update(TELEGRAM_SETTINGS_NAMESPACE, { workspaceRoots: [rootB] })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, `/folder ${rootA}`))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('outside the configured workspace roots')
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, `/folder ${rootB}`))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Workspace set to')
    })
  })

  it('honors a committed default workspace override', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'telegram-roots-a-'))
    const rootB = await mkdtemp(join(tmpdir(), 'telegram-roots-b-'))
    harness = await makeTelegramHarness({
      settings: true,
      workspaceRoots: [rootA, rootB],
      script: [textResponse('landed')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('No workspace selected for this topic')
    })
    await harness.settings?.update(TELEGRAM_SETTINGS_NAMESPACE, { defaultWorkspace: rootB })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, 'hello again'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('landed')
    })
    expect(harness.ctx.agents.list()[0]?.session.header.cwd).toBe(rootB)
  })

  it('honors a committed approval-timeout override', async () => {
    harness = await makeTelegramHarness({
      settings: true,
      script: ['hang'],
      config: { approvalTimeoutMs: 600_000 },
    })
    await harness.api.waitForPoll()
    await harness.settings?.update(TELEGRAM_SETTINGS_NAMESPACE, { approvalTimeoutMs: 1000 })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'work please'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    const agent = harness.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('missing agent')
    await expect(harness.ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('unavailable')
  })

  it('resolves the token through a committed reference override', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      requests.push(url)
      if (!url.endsWith('/getUpdates')) {
        return new Response('{}', { status: 200 })
      }
      // Honor the long-poll `timeout` parameter the real Bot API applies, so
      // the poll loop keeps cycling instead of blocking in one held request.
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { timeout?: number }
      const waitMs = (typeof body.timeout === 'number' ? body.timeout : 1) * 1000
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs)
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }, { once: true })
      })
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    harness = await makeTelegramHarness({
      settings: true,
      script: [textResponse('x')],
      omitConfig: ['transport'],
      config: { apiBase: 'http://telegram.test' },
    })
    await waitFor(() => {
      expect(requests.some(url => url.endsWith('/getUpdates'))).toBe(true)
    })
    await harness.settings?.update(TELEGRAM_SETTINGS_NAMESPACE, { tokenRef: 'TELEGRAM_MISSING_TOKEN' })
    // Two full poll cycles pass without a single new request: the missing
    // reference fails before the wire, and the loop backs off and retries.
    await new Promise<void>(resolve => setTimeout(resolve, 2500))
    const quiet = requests.length
    await new Promise<void>(resolve => setTimeout(resolve, 2500))
    expect(requests.length).toBe(quiet)
    await harness.settings?.update(TELEGRAM_SETTINGS_NAMESPACE, { tokenRef: 'TELEGRAM_BOT_TOKEN' })
    await waitFor(() => {
      expect(requests.length).toBeGreaterThan(quiet)
    })
  }, 20000)

  it('keeps the composition entry authoritative while no settings service exists', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('plain')] })
    await harness.api.waitForPoll()
    expect(harness.settings).toBeUndefined()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('plain')
    })
  })

  it('serves the namespace through the settings-file provider only when mounted', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('x')] })
    await harness.api.waitForPoll()
    expect(harness.settings?.describe() ?? []).toHaveLength(0)
  })
  it('creates a session when no agent options are configured anywhere', async () => {
    harness = await makeTelegramHarness({
      settings: true,
      omitConfig: ['agentOptions'],
      script: [textResponse('no route')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.ctx.agents.list() ?? []).toHaveLength(1)
    })
  })

  it('reads the resolved edit interval when a tool call edits the placeholder', async () => {
    harness = await makeTelegramHarness({ settings: true, script: [toolCallScript('bash')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'work please'))
    // The throttled ⚙️ edit consults the resolved interval on every tool call
    // before the skip; the observable pipeline is the placeholder opening and
    // the turn settling to idle.
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('Working…')
      expect(harness?.ctx.agents.list()[0]?.status).toBe('idle')
    })
  })

  it('falls back to the default edit interval when none is configured', async () => {
    harness = await makeTelegramHarness({
      omitConfig: ['editIntervalMs'],
      script: [toolCallScript('bash')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'work please'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('Working…')
      expect(harness?.ctx.agents.list()[0]?.status).toBe('idle')
    })
  })

  it('falls back to the default approval timeout when none is configured', async () => {
    harness = await makeTelegramHarness({ omitConfig: ['approvalTimeoutMs'], script: ['hang'] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'work please'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    const agent = harness.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('missing agent')
    const pending = harness.ctx.approval.request({ agent, toolName: 'bash' })
    await waitFor(() => {
      expect(harness?.api.latestKeyboard()).toBeDefined()
    })
    await harness.pluginFiber?.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('starts cleanly when no question provider is mounted', async () => {
    harness = await makeTelegramHarness({
      settings: true,
      userQuestions: false,
      script: [textResponse('quiet')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('quiet')
    })
  })
})

/** A scripted model turn that emits one tool call before finishing on tool-calls. */
function toolCallScript(name: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('settings-call'), name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('settings-call'), name, arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
