import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TelegramApiError } from '../src/bot.ts'
import { telegramTopicsDomain, topicKeyOf, TopicRegistry, sessionIdForKey } from '../src/topics.ts'
import {
  ALLOWED_USER,
  callbackUpdate,
  documentUpdate,
  FORUM_TOPIC,
  GENERAL_TOPIC,
  makeTelegramHarness,
  photoUpdate,
  textResponse,
  textUpdate,
  topicCreatedUpdate,
  type TelegramHarness,
} from './harness.ts'

/** Restart flows boot a second harness and wait for persistence; the default 1s waitFor budget is too tight. */
function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 8000, interval: 25 })
}

describe('Telegram topic frontend', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('creates a session for the first message and renders the committed answer', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('hello back')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('hello back')
    })
    const agents = harness.ctx.agents.list()
    expect(agents).toHaveLength(1)
    expect(agents[0]?.session.header.cwd).toBe(harness.roots[0])
    expect(agents[0]?.session.id).toMatch(/^tg-[0-9a-f]{8}-1$/u)
    // The working placeholder preceded the answer and was then deleted.
    expect(harness.api.texts()[0]).toBe('Working…')
    expect(harness.api.sent.some(send => send.method === 'deleteMessage')).toBe(true)
  })

  it('routes further messages to the same session', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('one'), textResponse('two')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'first'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('one')
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, 'second'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('two')
    })
    expect(harness.ctx.agents.list()).toHaveLength(1)
    expect(harness.adapter.requests).toHaveLength(2)
  })

  it('keeps topics independent in one chat', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('general'), textResponse('topic')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hi general'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('general')
    })
    harness.api.push(textUpdate(2, FORUM_TOPIC, 'hi topic'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('topic')
    })
    const agents = harness.ctx.agents.list()
    expect(agents).toHaveLength(2)
    const keys = agents.map(agent => `${agent.session.header.cwd}`)
    expect(new Set(keys).size).toBe(1)
  })

  it('drops unauthorized chats without creating sessions', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('never')] })
    await harness.api.waitForPoll()
    harness.api.push({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 9999 },
        from: { id: ALLOWED_USER, is_bot: false, first_name: 'u' },
        text: 'intruder',
      },
    })
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(0)
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
    expect(harness.api.texts()).toHaveLength(0)
  })

  it('queues followups and refuses beyond the cap', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    await harness.api.waitForPoll()
    for (let index = 1; index <= 5; index += 1) {
      harness.api.push(textUpdate(index, GENERAL_TOPIC, `message ${index}`))
    }
    await waitFor(() => {
      expect(harness?.api.texts().some(text => text.startsWith('Busy'))).toBe(true)
    })
    expect(harness.adapter.requests).toHaveLength(1)
  })

  it('supports /folder and /help before any session exists', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('later')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, '/folder'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Allowed roots:')
    })
    const outside = await mkdtemp(join(tmpdir(), 'telegram-outside-'))
    harness.api.push(textUpdate(2, GENERAL_TOPIC, `/folder ${outside}`))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('outside the configured workspace roots')
    })
    harness.api.push(textUpdate(3, GENERAL_TOPIC, `/folder ${harness.roots[0]}`))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Workspace set to')
    })
    harness.api.push(textUpdate(4, GENERAL_TOPIC, '/help'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('/reset')
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('reports /status and cancels with /cancel', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'work please'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, '/status'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('State: running')
    })
    harness.api.push(textUpdate(3, GENERAL_TOPIC, '/cancel'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('Cancelled.')
    })
    await waitFor(() => {
      expect(harness?.ctx.agents.list()[0]?.status).toBe('idle')
    })
  })

  it('archives the current session and starts a fresh generation on /reset', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('first'), textResponse('second')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'start'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('first')
    })
    const firstSessionId = harness.ctx.agents.list()[0]?.session.id
    harness.api.push(textUpdate(2, GENERAL_TOPIC, '/reset'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Reset complete')
    })
    const agents = harness.ctx.agents.list()
    expect(agents).toHaveLength(1)
    expect(agents[0]?.session.id).not.toBe(firstSessionId)
    expect(agents[0]?.session.id).toMatch(/-2$/u)
    // The fresh session still answers in the same topic.
    harness.api.push(textUpdate(3, GENERAL_TOPIC, 'again'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('second')
    })
  })

  it('records topic titles from service messages without creating sessions', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('x')] })
    await harness.api.waitForPoll()
    harness.api.push(topicCreatedUpdate(1, FORUM_TOPIC, 'API Work'))
    const domain = harness.ctx.storageDomain
    await waitFor(() => {
      const topics = domain.get('telegram_topics')?.table('topics')
      const record = topics?.get(topicKeyOf(FORUM_TOPIC.chatId, FORUM_TOPIC.threadId)) as { topicTitle?: string } | undefined
      expect(record?.topicTitle).toBe('API Work')
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('adopts a persisted deterministic session when the mapping write was lost', async () => {
    const seeded = await makeTelegramHarness({ mountPlugin: false, script: [textResponse('seeded')] })
    const key = topicKeyOf(GENERAL_TOPIC.chatId, null)
    const sessionId = sessionIdForKey(key, 1)
    const handle = await seeded.ctx.agents.create({
      sessionId,
      meta: { cwd: seeded.roots[0] as string },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'seed' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    await seeded.ctx.sessions.flush(handle.agent.session)
    const { storageRoot, persistenceRoot, roots } = seeded
    await seeded.dispose()

    harness = await makeTelegramHarness({
      storageRoot,
      persistenceRoot,
      workspaceRoots: roots,
      script: [textResponse('adopted')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('adopted')
    })
    expect(harness.ctx.agents.list()[0]?.session.id).toBe(sessionId)
  }, 20000)

  it('resumes the mapped session after a full restart', async () => {
    const first = await makeTelegramHarness({ script: [textResponse('before restart')] })
    await first.api.waitForPoll()
    first.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(first.api.texts()).toContain('before restart')
    })
    const sessionId = first.ctx.agents.list()[0]?.session.id
    const { storageRoot, persistenceRoot, roots } = first
    await first.dispose()

    harness = await makeTelegramHarness({
      storageRoot,
      persistenceRoot,
      workspaceRoots: roots,
      script: [textResponse('after restart')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(2, GENERAL_TOPIC, 'again'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('after restart')
    })
    expect(harness.ctx.agents.list()[0]?.session.id).toBe(sessionId)
  }, 20000)

  it('refuses to resume when the mapping workspace conflicts with the session cwd', async () => {
    const first = await makeTelegramHarness({ script: [textResponse('before tamper')] })
    await first.api.waitForPoll()
    first.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(first.api.texts()).toContain('before tamper')
    })
    const sessionId = first.ctx.agents.list()[0]?.session.id
    const { storageRoot, persistenceRoot, roots } = first
    await first.dispose()

    // Rewrite the mapping row to point at a different canonical workspace.
    const seeder = await makeTelegramHarness({ mountPlugin: false, storageRoot, persistenceRoot, workspaceRoots: roots })
    const otherWorkspace = await mkdtemp(join(tmpdir(), 'telegram-other-'))
    const domain = await seeder.ctx.storageDomain.open(telegramTopicsDomain)
    const registry = new TopicRegistry(domain)
    const key = topicKeyOf(GENERAL_TOPIC.chatId, null)
    const row = registry.get(key)
    if (row === undefined) throw new Error('expected mapping row')
    await registry.put(key, { ...row, workspace: otherWorkspace })
    await seeder.dispose()

    harness = await makeTelegramHarness({
      storageRoot,
      persistenceRoot,
      workspaceRoots: roots,
      script: [textResponse('never sent')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(2, GENERAL_TOPIC, 'hello again'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('created in workspace')
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
    expect(sessionId).toMatch(/^tg-/u)
  })

  it('answers approval requests through inline buttons and fails closed on timeout', async () => {
    harness = await makeTelegramHarness({ script: ['hang'], config: { approvalTimeoutMs: 200 } })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'work please'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    const agent = harness.ctx.agents.list()[0] as Agent
    const pending = harness.ctx.approval.request({ agent, toolName: 'bash' })
    await waitFor(() => {
      expect(harness?.api.latestKeyboard()).toBeDefined()
    })
    const keyboard = harness.api.latestKeyboard()!
    expect(keyboard[0]?.map(button => button.text)).toEqual(['Allow once', 'Reject'])
    const allow = keyboard[0]?.[0]
    if (allow === undefined) throw new Error('missing allow button')
    harness.api.push(callbackUpdate(2, allow.callback_data))
    await expect(pending).resolves.toBe('allowed-once')

    const timedOut = harness.ctx.approval.request({ agent, toolName: 'bash' })
    await expect(timedOut).resolves.toBe('unavailable')
  })

  it('collects user-question answers through inline buttons', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('done')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'ask me'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('done')
    })
    const agent = harness.ctx.agents.list()[0] as Agent
    const answerPromise = harness.ctx.userQuestions.ask({
      agent,
      questions: [{
        id: 'q1',
        question: 'Pick one?',
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    await waitFor(() => {
      expect(harness?.api.latestKeyboard()).toBeDefined()
    })
    const keyboard = harness.api.latestKeyboard()!
    const optionA = keyboard.flat().find(button => button.text === 'A')
    if (optionA === undefined) throw new Error('missing option button')
    harness.api.push(callbackUpdate(2, optionA.callback_data))
    const answer = await answerPromise
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['A'] }])
  })

  it('toggles multi-select question options until done', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('done')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'ask me'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('done')
    })
    const agent = harness.ctx.agents.list()[0] as Agent
    const answerPromise = harness.ctx.userQuestions.ask({
      agent,
      questions: [{
        id: 'q1',
        question: 'Pick many?',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    await waitFor(() => {
      expect(harness?.api.latestKeyboard()).toBeDefined()
    })
    let pressSeq = 10
    const press = (label: string): void => {
      const keyboard = harness!.api.latestKeyboard()!
      const button = keyboard.flat().find(candidate => candidate.text === label)
      if (button === undefined) throw new Error(`missing button ${label}`)
      pressSeq += 1
      harness!.api.push(callbackUpdate(pressSeq, button.callback_data))
    }
    press('A')
    await waitFor(() => {
      const marked = harness!.api.latestKeyboard()!.flat().some(button => button.text === '✓ A')
      expect(marked).toBe(true)
    })
    press('B')
    press('Done')
    const answer = await answerPromise
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['A', 'B'] }])
  })

  it('saves inbound photos through the attachment seam and feeds image blocks to the model', async () => {
    harness = await makeTelegramHarness({
      attachments: true,
      imageCapable: true,
      script: [textResponse('nice photo')],
    })
    harness.api.registerFile('photo1', 'photos/file_1.jpg', new Uint8Array([1, 2, 3]))
    await harness.api.waitForPoll()
    harness.api.push(photoUpdate(1, GENERAL_TOPIC, 'photo1', 'holiday pic'))
    await waitFor(() => {
      expect(harness?.attachments?.saved ?? []).toHaveLength(1)
    })
    expect(harness.attachments?.saved[0]?.mediaType).toBe('image/jpeg')
    const request = harness.adapter.requests[0]
    const content = JSON.stringify(request?.messages)
    expect(content).toContain('"type":"image"')
    expect(content).toContain('holiday pic')
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('nice photo')
    })
  })

  it('rejects photos when the route cannot accept images', async () => {
    harness = await makeTelegramHarness({ attachments: true, script: [textResponse('x')] })
    await harness.api.waitForPoll()
    harness.api.push(photoUpdate(1, GENERAL_TOPIC, 'photo1'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('not supported')
    })
    expect(harness.adapter.requests).toHaveLength(0)
  })

  it('downloads documents into the workspace inbox and references the path', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('got the file')] })
    harness.api.registerFile('doc1', 'documents/file_1.txt', new TextEncoder().encode('hello doc'))
    await harness.api.waitForPoll()
    harness.api.push(documentUpdate(1, GENERAL_TOPIC, 'doc1', 'notes.txt', 'read this first'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Saved _telegram_inbox/notes.txt')
    })
    const inbox = join(harness.roots[0] as string, '_telegram_inbox', 'notes.txt')
    expect(await readFile(inbox, 'utf8')).toBe('hello doc')
    expect(JSON.stringify(harness.adapter.requests[0]?.messages)).toContain('read this first')
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('got the file')
    })
  })

  it('pauses posting into a closed topic and resumes on reopen', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('answer one'), textResponse('answer two')] })
    await harness.api.waitForPoll()
    harness.api.failNext(new TelegramApiError('Bad Request: message thread is closed', 400, undefined))
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'during close'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    // The closed-topic send failed; the answer must not be posted.
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(harness.api.texts()).not.toContain('answer one')
    harness.api.push({
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: GENERAL_TOPIC.chatId },
        from: { id: ALLOWED_USER, is_bot: false, first_name: 'u' },
        forum_topic_reopened: {},
      },
    })
    harness.api.push(textUpdate(3, GENERAL_TOPIC, 'after reopen'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('answer two')
    })
  })

  it('unwinds every registration and live agent on plugin disposal', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('hello')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('hello')
    })
    const agent = harness.ctx.agents.list()[0] as Agent
    expect(harness.ctx.commands.find(agent, 'status')).toBeDefined()
    await harness.pluginFiber?.dispose()
    expect(harness.ctx.agents.list()).toHaveLength(0)
    expect(harness.ctx.commands.find(agent, 'status')).toBeUndefined()
  })

  it('settles pending approvals as cancelled when the plugin disposes', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'work please'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    const agent = harness.ctx.agents.list()[0] as Agent
    const pending = harness.ctx.approval.request({ agent, toolName: 'bash' })
    await waitFor(() => {
      expect(harness?.api.latestKeyboard()).toBeDefined()
    })
    await harness.pluginFiber?.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('warns unknown callback data instead of crashing', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('x')] })
    await harness.api.waitForPoll()
    harness.api.push(callbackUpdate(1, 'tg-ap:stale:allow'))
    await waitFor(() => {
      expect(harness?.api.sent.some(send => send.method === 'answerCallbackQuery')).toBe(true)
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })
})
