/**
 * Human-interaction bridge: inline-keyboard answers for approval requests and
 * `ask_user_question` items, posted into the asking agent's topic. Unanswered
 * prompts settle fail-closed (`unavailable` for approvals, partial answers
 * for questions) after the configured timeout; stale button presses are
 * acknowledged and ignored.
 * @module @deepseek-ai/dsh-telegram/src/interactions
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionOption,
} from '@deepseek-ai/dsh-user-questions'
import type { TelegramApi } from './bot.ts'
import type { CallbackQuery, ChatTarget, InlineButton } from './types.ts'

/** Telegram inline-keyboard button label limit. */
const MAX_BUTTON_LABEL_CHARS = 64

/** One pending approval prompt. */
interface ApprovalEntry {
  readonly target: ChatTarget
  messageId: number
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly timer: NodeJS.Timeout
}

/** One pending question. */
interface QuestionState {
  readonly question: AskUserQuestionItem
  readonly options: readonly AskUserQuestionOption[]
  readonly selected: Set<string>
  messageId: number
  answered: boolean
}

interface QuestionEntry {
  readonly target: ChatTarget
  readonly states: QuestionState[]
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly timer: NodeJS.Timeout
}

/** Truncate a button label to Telegram's limit, preserving a suffix marker. */
function buttonLabel(label: string): string {
  return label.length <= MAX_BUTTON_LABEL_CHARS ? label : `${label.slice(0, MAX_BUTTON_LABEL_CHARS - 1)}…`
}

/**
 * Interaction bridge bound to one transport. The runtime owns routing (which
 * agent belongs to which topic); this class owns the pending-prompt tables,
 * the button wire format, timeout settlement, and teardown.
 */
export class InteractionBridge {
  private readonly approvals = new Map<string, ApprovalEntry>()
  private readonly questions = new Map<string, QuestionEntry>()
  private disposed = false

  /**
   * @param api - The Telegram transport.
   * @param targetForAgent - Maps an exact live agent to its chat target, or `undefined` when unowned.
   * @param timeoutMs - Unanswered-prompt timeout, read per prompt so a settings change applies live; settlements are fail-closed.
   * @param logger - Structured logger.
   */
  constructor(
    private readonly api: TelegramApi,
    private readonly targetForAgent: (agent: Agent) => ChatTarget | undefined,
    private readonly timeoutMs: () => number,
    private readonly logger: Context['logger'],
  ) {}

  /**
   * Present one approval request as an [Allow once] [Reject] prompt in the
   * asking agent's topic. Resolves on a button press, on request
   * cancellation, or fail-closed `unavailable` at the timeout.
   * @param request - The pending approval request.
   * @param target - The topic the request belongs to.
   * @returns the decision the harness folds into the approval outcome.
   */
  async askApproval(request: ApprovalRequest, target: ChatTarget): Promise<ApprovalOutcome> {
    if (this.disposed) return 'unavailable'
    const id = randomUUID()
    const completion = Promise.withResolvers<ApprovalOutcome>()
    const entry: ApprovalEntry = {
      target,
      messageId: -1,
      resolve: completion.resolve,
      timer: setTimeout(() => { this.settleApproval(id, 'unavailable') }, this.timeoutMs()),
    }
    this.approvals.set(id, entry)
    try {
      const label = request.reason === undefined
        ? `Approve tool ${request.toolName}?`
        : `Approve tool ${request.toolName}?\n${request.reason}`
      const sent = await this.api.sendMessage(target, label, {
        replyMarkup: [[
          { text: 'Allow once', callback_data: `tg-ap:${id}:allow` },
          { text: 'Reject', callback_data: `tg-ap:${id}:reject` },
        ]],
      })
      entry.messageId = sent.message_id
    } catch (error) {
      this.entriesCleanup(id)
      this.logger.warn(`telegram: approval prompt send failed: ${String(error)}`)
      return 'unavailable'
    }
    request.signal?.addEventListener('abort', () => { this.settleApproval(id, 'cancelled') }, { once: true })
    return await completion.promise
  }

  /**
   * Waterfall listener answering `user-questions/request` through topic buttons.
   * @returns the listener function for `ctx.on('user-questions/request', ...)`.
   */
  questionsListener(): (
    request: { agent?: Agent; questions: AskUserQuestionItem[]; signal?: AbortSignal },
    next: () => Promise<AskUserQuestionAnswer>,
  ) => Promise<AskUserQuestionAnswer> {
    return async (request, next): Promise<AskUserQuestionAnswer> => {
      if (this.disposed) return next()
      const target = request.agent === undefined ? undefined : this.targetForAgent(request.agent)
      if (target === undefined) return next()
      const id = randomUUID()
      const completion = Promise.withResolvers<AskUserQuestionAnswer>()
      const entry: QuestionEntry = {
        target,
        states: request.questions.map(question => ({
          question,
          options: question.options ?? [],
          selected: new Set<string>(),
          messageId: -1,
          answered: false,
        })),
        resolve: completion.resolve,
        timer: setTimeout(() => { this.settleQuestions(id) }, this.timeoutMs()),
      }
      this.questions.set(id, entry)
      for (let index = 0; index < request.questions.length; index += 1) {
        const state = entry.states[index] as QuestionState
        try {
          const sent = await this.api.sendMessage(target, this.questionText(state), {
            replyMarkup: this.questionButtons(id, index, state),
          })
          state.messageId = sent.message_id
        } catch (error) {
          this.logger.warn(`telegram: question prompt send failed: ${String(error)}`)
        }
      }
      request.signal?.addEventListener('abort', () => { this.settleQuestions(id) }, { once: true })
      return await completion.promise
    }
  }

  /**
   * Route one callback button press to its pending prompt. Unknown or stale
   * data is acknowledged with a short note and ignored.
   * @param query - The callback press.
   * @returns `true` when the press belonged to a pending prompt.
   */
  async handleCallback(query: CallbackQuery): Promise<boolean> {
    const data = query.data ?? ''
    await this.api.answerCallbackQuery(query.id)
    if (data.startsWith('tg-ap:')) {
      const [, id, choice] = data.split(':')
      if (id !== undefined && (choice === 'allow' || choice === 'reject')) {
        const entry = this.approvals.get(id)
        if (entry === undefined) return false
        if (query.message?.chat.id !== entry.target.chatId) return false
        this.settleApproval(id, choice === 'allow' ? 'allowed-once' : 'rejected')
        return true
      }
      return false
    }
    if (data.startsWith('tg-q:')) {
      const parts = data.split(':')
      const id = parts[1]
      const questionIndex = parts[2]
      const action = parts[3]
      if (id === undefined || questionIndex === undefined || action === undefined) return false
      const entry = this.questions.get(id)
      if (entry === undefined) return false
      if (query.message?.chat.id !== entry.target.chatId) return false
      const state = entry.states[Number(questionIndex)]
      if (state === undefined || state.answered) return false
      if (action === 'done') {
        state.answered = true
        await this.removeKeyboard(entry.target, state.messageId)
        if (entry.states.every(candidate => candidate.answered)) this.settleQuestions(id)
        return true
      }
      const option = state.options[Number(action)]
      if (option === undefined) return false
      if (state.question.multiSelect === true) {
        if (state.selected.has(option.label)) state.selected.delete(option.label)
        else state.selected.add(option.label)
        await this.reRenderButtons(id, entry, state)
      } else {
        state.selected.clear()
        state.selected.add(option.label)
        state.answered = true
        await this.removeKeyboard(entry.target, state.messageId)
        if (entry.states.every(candidate => candidate.answered)) this.settleQuestions(id)
      }
      return true
    }
    await this.api.answerCallbackQuery(query.id, { text: 'This prompt has expired.' })
    return false
  }

  /** Teardown: settle every pending prompt so no agent waits on a dead bridge. */
  dispose(): void {
    this.disposed = true
    for (const id of [...this.approvals.keys()]) this.settleApproval(id, 'cancelled')
    for (const id of [...this.questions.keys()]) this.settleQuestions(id)
  }

  private settleApproval(id: string, outcome: ApprovalOutcome): void {
    const entry = this.approvals.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.approvals.delete(id)
    if (entry.messageId >= 0) void this.removeKeyboard(entry.target, entry.messageId)
    entry.resolve(outcome)
  }

  private settleQuestions(id: string): void {
    const entry = this.questions.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.questions.delete(id)
    for (const state of entry.states) {
      if (state.messageId >= 0 && !state.answered) void this.removeKeyboard(entry.target, state.messageId)
    }
    entry.resolve({
      answers: entry.states.map(state => ({
        id: state.question.id,
        selected: [...state.selected],
      })),
    })
  }

  private entriesCleanup(id: string): void {
    const entry = this.approvals.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.approvals.delete(id)
  }

  private questionText(state: QuestionState): string {
    const lines = [
      state.question.header !== undefined ? `*${state.question.header}*` : undefined,
      state.question.question,
      state.question.detail,
    ].filter((line): line is string => line !== undefined)
    return lines.join('\n')
  }

  private questionButtons(id: string, questionIndex: number, state: QuestionState): InlineButton[][] {
    const rows: InlineButton[][] = state.options.map((option, optionIndex) => [{
      text: buttonLabel(state.selected.has(option.label) ? `✓ ${option.label}` : option.label),
      callback_data: `tg-q:${id}:${questionIndex}:${optionIndex}`,
    }])
    if (state.question.multiSelect === true) {
      rows.push([{ text: 'Done', callback_data: `tg-q:${id}:${questionIndex}:done` }])
    }
    return rows
  }

  private async reRenderButtons(id: string, entry: QuestionEntry, state: QuestionState): Promise<void> {
    const questionIndex = entry.states.indexOf(state)
    try {
      await this.api.editInlineKeyboard(entry.target, state.messageId, this.questionButtons(id, questionIndex, state))
    } catch (error) {
      this.logger.warn(`telegram: question re-render failed: ${String(error)}`)
    }
  }

  private async removeKeyboard(target: ChatTarget, messageId: number): Promise<void> {
    try {
      await this.api.removeInlineKeyboard(target, messageId)
    } catch (error) {
      this.logger.warn(`telegram: keyboard removal failed: ${String(error)}`)
    }
  }
}
