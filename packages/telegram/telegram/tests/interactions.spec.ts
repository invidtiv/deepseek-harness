import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { InteractionBridge } from '../src/interactions.ts'
import type { CallbackQuery, ChatTarget, InlineKeyboard } from '../src/types.ts'
import { StubTelegramApi } from './stub-api.ts'

const TARGET: ChatTarget = { chatId: 1001, threadId: 7 }
const AGENT = { id: 'agent-1' } as unknown as Agent
const UNOWNED = { id: 'agent-2' } as unknown as Agent

/** Bridge routing only {@link AGENT} to {@link TARGET}. */
function bridge(api: StubTelegramApi, timeoutMs = 10_000): InteractionBridge {
  return new InteractionBridge(
    api,
    agent => agent === AGENT ? TARGET : undefined,
    () => timeoutMs,
    new Context().logger,
  )
}

function approvalRequest(extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent: AGENT, toolName: 'bash', ...extra }
}

function callback(data: string | undefined, chatId = TARGET.chatId): CallbackQuery {
  return {
    id: 'cb-1',
    from: { id: 5, is_bot: false },
    message: { message_id: 1, chat: { id: chatId } },
    ...data === undefined ? {} : { data },
  }
}

/** The callback data of the button carrying `label` in the latest keyboard. */
function buttonData(keyboard: InlineKeyboard | undefined, label: string): string {
  const button = keyboard?.flat().find(candidate => candidate.text === label)
  if (button === undefined) throw new Error(`missing button ${label}`)
  return button.callback_data
}

function press(view: InteractionBridge, api: StubTelegramApi, label: string): Promise<boolean> {
  return view.handleCallback(callback(buttonData(api.latestKeyboard(), label)))
}

function ask(view: InteractionBridge, questions: AskUserQuestionItem[], options: {
  agent?: Agent
  signal?: AbortSignal
} = {}): Promise<import('@deepseek-ai/dsh-user-questions').AskUserQuestionAnswer> {
  const noFallback = () => Promise.reject(new Error('no fallback'))
  return view.questionsListener()({
    questions,
    ...options.agent === undefined ? {} : { agent: options.agent },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }, noFallback)
}

function settled(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 20))
}

describe('InteractionBridge approvals', () => {
  it('presents the asker reason and answers a rejection', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = view.askApproval(approvalRequest({ reason: 'writes outside the workspace' }), TARGET)
    await Promise.resolve()
    expect(api.of('sendMessage')[0]?.text).toBe('Approve tool bash?\nwrites outside the workspace')
    await press(view, api, 'Reject')
    await expect(pending).resolves.toBe('rejected')
    expect(api.of('removeInlineKeyboard')).toHaveLength(1)
  })

  it('ignores a press from another chat and unknown button choices', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = view.askApproval(approvalRequest(), TARGET)
    await Promise.resolve()
    const allow = buttonData(api.latestKeyboard(), 'Allow once')
    expect(await view.handleCallback(callback(allow, 999))).toBe(false)
    expect(await view.handleCallback(callback('tg-ap:unknown-id:allow'))).toBe(false)
    expect(await view.handleCallback(callback(`tg-ap:${allow.split(':')[1] ?? ''}:maybe`))).toBe(false)
    expect(await view.handleCallback(callback(allow))).toBe(true)
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('answers unavailable when the prompt cannot be posted', async () => {
    const api = new StubTelegramApi()
    api.failOn('sendMessage', new Error('chat not found'))
    await expect(bridge(api).askApproval(approvalRequest(), TARGET)).resolves.toBe('unavailable')
    expect(api.of('removeInlineKeyboard')).toHaveLength(0)
  })

  it('answers unavailable once the bridge is disposed', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    view.dispose()
    await expect(view.askApproval(approvalRequest(), TARGET)).resolves.toBe('unavailable')
    expect(api.calls).toHaveLength(0)
  })

  it('settles cancelled when the asker withdraws, before and after an answer', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const withdrawn = new AbortController()
    const pending = view.askApproval(approvalRequest({ signal: withdrawn.signal }), TARGET)
    await Promise.resolve()
    withdrawn.abort(new Error('step aborted'))
    await expect(pending).resolves.toBe('cancelled')

    const answered = new AbortController()
    const second = view.askApproval(approvalRequest({ signal: answered.signal }), TARGET)
    await Promise.resolve()
    await press(view, api, 'Allow once')
    await expect(second).resolves.toBe('allowed-once')
    // A late withdrawal of an already-settled prompt is a no-op.
    answered.abort(new Error('too late'))
    await settled()
  })

  it('fails closed at the timeout, even before the prompt finished posting', async () => {
    const api = new StubTelegramApi()
    api.sendDelayMs = 30
    const view = bridge(api, 1)
    await expect(view.askApproval(approvalRequest(), TARGET)).resolves.toBe('unavailable')
    // The prompt had no message id when the timeout fired, so nothing is edited.
    expect(api.of('removeInlineKeyboard')).toHaveLength(0)
  })

  it('fails closed once when the timeout beats a failing send', async () => {
    const api = new StubTelegramApi()
    api.sendDelayMs = 30
    api.failOn('sendMessage', new Error('chat not found'))
    await expect(bridge(api, 1).askApproval(approvalRequest(), TARGET)).resolves.toBe('unavailable')
  })

  it('settles a pending approval as cancelled when the bridge disposes', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = view.askApproval(approvalRequest(), TARGET)
    await Promise.resolve()
    view.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('removes the keyboard best-effort when Telegram refuses the edit', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    api.failOn('removeInlineKeyboard', new Error('message to edit not found'))
    const pending = view.askApproval(approvalRequest(), TARGET)
    await Promise.resolve()
    await press(view, api, 'Allow once')
    await expect(pending).resolves.toBe('allowed-once')
  })
})

describe('InteractionBridge questions', () => {
  it('posts one prompt per question with its header, detail, and truncated labels', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const longLabel = 'L'.repeat(80)
    const pending = ask(view, [{
      id: 'q1',
      header: 'Choose',
      question: 'Which one?',
      detail: 'extra context',
      options: [{ label: longLabel }, { label: 'B' }],
    }], { agent: AGENT })
    await Promise.resolve()
    expect(api.of('sendMessage')[0]?.text).toBe('*Choose*\nWhich one?\nextra context')
    const labels = api.latestKeyboard()?.flat().map(button => button.text)
    expect(labels?.[0]).toBe(`${'L'.repeat(63)}…`)
    await press(view, api, 'B')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B'] }] })
  })

  it('toggles a multi-select option off again before Done', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = ask(view, [{
      id: 'q1',
      question: 'Which ones?',
      multiSelect: true,
      options: [{ label: 'A' }, { label: 'B' }],
    }], { agent: AGENT })
    await Promise.resolve()
    await press(view, api, 'A')
    await press(view, api, '✓ A')
    await press(view, api, 'B')
    await press(view, api, 'Done')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B'] }] })
  })

  it('contains a failed keyboard re-render during a multi-select toggle', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = ask(view, [{
      id: 'q1',
      question: 'Which ones?',
      multiSelect: true,
      options: [{ label: 'A' }],
    }], { agent: AGENT })
    await Promise.resolve()
    api.failOn('editInlineKeyboard', new Error('message is not modified'))
    expect(await press(view, api, 'A')).toBe(true)
    expect(await view.handleCallback(callback(buttonData(api.latestKeyboard(), 'Done')))).toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('waits for every question before answering', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = ask(view, [
      { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
      { id: 'q2', question: 'Second?', multiSelect: true, options: [{ label: 'B' }] },
    ], { agent: AGENT })
    await Promise.resolve()
    const first = api.of('sendMessage')[0]
    const second = api.of('sendMessage')[1]
    await view.handleCallback(callback(buttonData(second?.replyMarkup, 'B')))
    await view.handleCallback(callback(buttonData(second?.replyMarkup, 'Done')))
    await settled()
    await view.handleCallback(callback(buttonData(first?.replyMarkup, 'A')))
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['B'] }],
    })
  })

  it('answers with the selections made when the prompt times out', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api, 40)
    const pending = ask(view, [
      { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
      { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
    ], { agent: AGENT })
    await Promise.resolve()
    await view.handleCallback(callback(buttonData(api.of('sendMessage')[0]?.replyMarkup, 'A')))
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: [] }],
    })
    // The unanswered prompt lost its keyboard; the answered one already had.
    expect(api.of('removeInlineKeyboard')).toHaveLength(2)
  })

  it('settles the pending questions when the asker aborts', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const controller = new AbortController()
    const pending = ask(view, [{ id: 'q1', question: 'Which?' }], { agent: AGENT, signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('step aborted'))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('ignores a withdrawal that arrives after the answer', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const controller = new AbortController()
    const pending = ask(
      view,
      [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }],
      { agent: AGENT, signal: controller.signal },
    )
    await Promise.resolve()
    await press(view, api, 'A')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
    controller.abort(new Error('too late'))
    await settled()
  })

  it('settles the pending questions when the bridge disposes', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = ask(view, [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }], { agent: AGENT })
    await Promise.resolve()
    view.dispose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('delegates to next when no topic is available or after disposal', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    await expect(ask(view, [{ id: 'q1', question: 'Which?' }])).rejects.toThrow('no fallback')
    await expect(ask(view, [{ id: 'q1', question: 'Which?' }], { agent: UNOWNED }))
      .rejects.toThrow('no fallback')
    view.dispose()
    await expect(ask(view, [{ id: 'q1', question: 'Which?' }], { agent: AGENT }))
      .rejects.toThrow('no fallback')
  })

  it('keeps waiting when a prompt could not be posted', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api, 40)
    api.failOn('sendMessage', new Error('chat not found'))
    const pending = ask(view, [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }], { agent: AGENT })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] })
    expect(api.of('removeInlineKeyboard')).toHaveLength(0)
  })

  it('acknowledges stale, malformed, and unknown presses', async () => {
    const api = new StubTelegramApi()
    const view = bridge(api)
    const pending = ask(view, [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }], { agent: AGENT })
    await Promise.resolve()
    const live = buttonData(api.latestKeyboard(), 'A')
    const id = live.split(':')[1] ?? ''
    expect(await view.handleCallback(callback(undefined))).toBe(false)
    expect(await view.handleCallback(callback('nonsense'))).toBe(false)
    expect(api.of('answerCallbackQuery').at(-1)?.text).toBe('This prompt has expired.')
    expect(await view.handleCallback(callback('tg-q:only-an-id'))).toBe(false)
    expect(await view.handleCallback(callback('tg-q:unknown:0:0'))).toBe(false)
    expect(await view.handleCallback(callback(live, 999))).toBe(false)
    expect(await view.handleCallback(callback(`tg-q:${id}:9:0`))).toBe(false)
    expect(await view.handleCallback(callback(`tg-q:${id}:0:9`))).toBe(false)
    expect(await view.handleCallback(callback(live))).toBe(true)
    // The answered question ignores a repeated press.
    expect(await view.handleCallback(callback(live))).toBe(false)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })
})
