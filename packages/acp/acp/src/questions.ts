/** Structured human answers projected through ACP form elicitation. */

import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** Scalar form fields supported by clients without array or optional-field controls. */
interface QuestionSchema {
  type: 'object'
  properties: Record<string, { type: 'string'; title: string; description: string; enum?: string[]; minLength: number }>
  required: string[]
}

/**
 * Build one scalar field per question; only fixed approvals restrict answers to an enum.
 * @param questions - validated questions, in display order.
 * @returns an ACP form usable by clients with primitive text and choice controls.
 */
export function questionSchema(questions: readonly AskUserQuestionItem[]): QuestionSchema {
  const properties: QuestionSchema['properties'] = {}
  const required: string[] = []
  questions.forEach((question, index) => {
    const key = `q${index}`
    const choices = question.options?.map(option => option.label) ?? []
    const fixed = (question.intent?.kind === 'approval' || question.intent?.kind === 'plan-review')
    const instruction = fixed ? undefined : question.multiSelect === true
      ? 'Enter one or more choices, one per line. You may also enter your own answer.'
      : choices.length > 0 ? 'Enter a choice or your own answer.' : undefined
    const description = [question.question, question.detail,
      ...question.options?.map(option => option.description === undefined ? option.label : `${option.label}: ${option.description}`) ?? [],
      instruction].filter(Boolean).join('\n')
    properties[key] = { type: 'string', title: question.question, description, minLength: 1,
      ...fixed && choices.length > 0 ? { enum: choices } : {} }
    required.push(key)
  })
  return { type: 'object', properties, required }
}

/**
 * Validate fixed approvals and distinguish offered labels from custom human text.
 * @param questions - original questions in schema order.
 * @param content - untrusted accepted form response.
 * @returns one answer per question, using the original ids.
 */
export function questionAnswer(questions: readonly AskUserQuestionItem[], content: unknown): AskUserQuestionAnswer {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new UserQuestionError('ACP elicitation returned no answer object', 'BAD_ANSWER')
  }
  const values = content as Record<string, unknown>
  if (Object.keys(values).some(key => !questions.some((_question, index) => key === `q${index}`))) {
    throw new UserQuestionError('ACP elicitation returned an invalid answer field', 'BAD_ANSWER')
  }
  return { answers: questions.map((question, index) => {
    const value = values[`q${index}`]
    const choices = question.options?.map(option => option.label) ?? []
    if (typeof value !== 'string' || value.trim().length === 0
      || ((question.intent?.kind === 'approval' || question.intent?.kind === 'plan-review') && !choices.includes(value))) {
      throw new UserQuestionError(`ACP elicitation returned an invalid answer for ${question.id}`, 'BAD_ANSWER')
    }
    const lines = question.multiSelect === true && !choices.includes(value)
      ? value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean) : [value]
    const selected = [...new Set(lines.filter(line => choices.includes(line)))]
    const custom = lines.filter(line => !choices.includes(line)).join('\n')
    return { id: question.id, selected, ...custom.length === 0 ? {} : { custom } }
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
