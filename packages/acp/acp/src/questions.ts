/** Structured human answers projected through ACP form elicitation. */

import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** Primitive form subset shared by ACP v1 and v2. */
interface QuestionSchema {
  type: 'object'
  properties: Record<string,
    | { type: 'string'; title: string; description?: string; enum?: string[]; minLength?: number }
    | { type: 'array'; title: string; description: string; items: { type: 'string'; enum: string[] } }>
  required: string[]
}

/**
 * Build primitive form fields without using caller ids as object keys.
 * @param questions - validated questions, in display order.
 * @returns an ACP form preserving choices and optional custom answers.
 */
export function questionSchema(questions: readonly AskUserQuestionItem[]): QuestionSchema {
  const properties: QuestionSchema['properties'] = {}
  const required: string[] = []
  questions.forEach((question, index) => {
    const key = `q${index}`
    const choices = question.options?.map(option => option.label) ?? []
    const description = [question.detail, ...question.options?.map(option => option.description === undefined
      ? option.label : `${option.label}: ${option.description}`) ?? []].filter(Boolean).join('\n')
    if (choices.length > 0) {
      properties[key] = question.multiSelect === true
        ? { type: 'array', title: question.question, description, items: { type: 'string', enum: choices } }
        : { type: 'string', title: question.question, description, enum: choices }
      if (question.intent?.kind === 'approval') required.push(key)
      else properties[`${key}_text`] = { type: 'string', title: `${question.question} — Other` }
    } else {
      properties[`${key}_text`] = { type: 'string', title: question.question, description, minLength: 1 }
      required.push(`${key}_text`)
    }
  })
  return { type: 'object', properties, required }
}

/**
 * Validate client answers against the offered questions before returning them to a tool.
 * @param questions - original questions in schema order.
 * @param content - untrusted accepted form response.
 * @returns one answer per question, using the original ids.
 */
export function questionAnswer(questions: readonly AskUserQuestionItem[], content: unknown): AskUserQuestionAnswer {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new UserQuestionError('ACP elicitation returned no answer object', 'BAD_ANSWER')
  }
  const values = content as Record<string, unknown>
  return { answers: questions.map((question, index) => {
    const key = `q${index}`
    const value = values[key]
    const text = values[`${key}_text`]
    const choices = question.options?.map(option => option.label) ?? []
    const entries: readonly unknown[] | null = value === undefined ? [] : typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
    const selected = entries?.filter((item): item is string => typeof item === 'string') ?? null
    if (selected === null || selected.length !== entries?.length || selected.some(item => !choices.includes(item))
      || (question.intent?.kind === 'approval' && (selected.length !== 1 || text !== undefined))
      || new Set(selected).size !== selected.length || (question.multiSelect !== true && selected.length > 1)
      || (text !== undefined && typeof text !== 'string')
      || (selected.length === 0 && (typeof text !== 'string' || text.trim().length === 0))) {
      throw new UserQuestionError(`ACP elicitation returned an invalid answer for ${question.id}`, 'BAD_ANSWER')
    }
    return { id: question.id, selected, ...typeof text === 'string' ? { custom: text } : {} }
  }) }
}

/**
 * Settle a human exchange on local cancellation even if its peer ignores cancellation.
 * @param send - start the wire request with the same cancellation signal.
 * @param signal - caller-owned cancellation lifetime.
 * @returns the peer response while the caller remains active.
 */
export function questionResponse<T>(send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return send()
  const cancellationError = (): Error => {
    const reason: unknown = signal.reason
    return reason instanceof Error ? reason : new UserQuestionError('ACP client request cancelled', 'ASK_ABORTED')
  }
  if (signal.aborted) return Promise.reject(cancellationError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(cancellationError()) }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve().then(() => {
      if (signal.aborted) throw cancellationError()
      return send()
    }).then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}
