/** ACP forms preserve question intent and validate remote human answers. */
import { afterEach, describe, expect, it } from 'vitest'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
type FormResponse =
  | { action: 'accept'; content: Record<string, string | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' }
import UserQuestions, { type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { questionAnswer, questionSchema } from '../src/questions.ts'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

const choices: AskUserQuestionItem = { id: '__proto__', question: 'Select features', options: [{ label: 'Read', description: 'Read files' }, { label: 'Write' }], multiSelect: true }
const approval: AskUserQuestionItem = {
  id: 'access', question: 'Allow access?', detail: 'Read the selected directory.',
  options: [{ label: 'Allow' }, { label: 'Reject' }, { label: 'Always' }],
  intent: { kind: 'approval', approve: 'Allow', reject: 'Reject', always: 'Always' },
}

it('uses positional keys and retains multi-select choices, descriptions, and custom answers', () => {
  expect(questionSchema([choices])).toMatchObject({ properties: { q0: { type: 'array', items: { enum: ['Read', 'Write'] }, description: 'Read: Read files\nWrite' }, q0_text: { type: 'string' } } })
  expect(questionAnswer([choices], { q0: ['Read', 'Write'], q0_text: 'Also inspect metadata' })).toEqual({ answers: [{ id: '__proto__', selected: ['Read', 'Write'], custom: 'Also inspect metadata' }] })
  expect(questionSchema([{ id: 'text', question: 'Describe it' }])).toMatchObject({ required: ['q0_text'] })
  expect(questionAnswer([{ id: 'text', question: 'Describe it' }], { q0_text: 'Details' })).toEqual({ answers: [{ id: 'text', selected: [], custom: 'Details' }] })
})

it('requires one offered approval action and never offers custom access grants', () => {
  expect(questionSchema([approval])).toMatchObject({ required: ['q0'], properties: { q0: { enum: ['Allow', 'Reject', 'Always'] } } })
  expect(questionSchema([approval]).properties).not.toHaveProperty('q0_text')
  expect(questionAnswer([approval], { q0: 'Allow' })).toEqual({ answers: [{ id: 'access', selected: ['Allow'] }] })
  for (const content of [{}, { q0_text: 'Allow everything' }, { q0: 'Allow', q0_text: '' }, { q0: 'Unknown' }, { q0: ['Allow', 'Reject'] }]) {
    expect(() => questionAnswer([approval], content)).toThrow(/invalid answer/)
  }
})

it('rejects malformed, empty, duplicate, unoffered and wrong-cardinality answers', () => {
  for (const content of [null, [], 'answer', {}, { q0: [1] }, { q0: ['Read', 'Read'] }, { q0: ['Delete'] }, { q0_text: false }, { q0_text: ' ' }]) {
    expect(() => questionAnswer([choices], content)).toThrow()
  }
  expect(() => questionAnswer([{ ...choices, multiSelect: false }], { q0: ['Read', 'Write'] })).toThrow(/invalid answer/)
})

let harness: BridgeHarness | undefined
afterEach(async () => { await harness?.dispose() })

describe.each([1, 2] as const)('ACP v%s user questions', (version) => {
  async function connected(
    form: boolean,
    respond: (signal: AbortSignal) => FormResponse | Promise<FormResponse> = () => ({ action: 'accept', content: { q0: ['Read'], q0_text: 'Custom' } })) {
    let client: v2.ClientContext | undefined
    const forms: unknown[] = []
    const permissions: unknown[] = []
    let allow = true
    harness = await makeBridgeHarness({ ...version === 1 ? {} : { connectClient: (stream) => {
      client = v2.client()
        .onRequest('elicitation/create', ({ params, signal }) => {
          forms.push(params)
          return Promise.resolve(respond(signal))
        })
        .onRequest('session/request_permission', ({ params }) => {
          permissions.push(params)
          return Promise.resolve({ outcome: { outcome: 'selected' as const, optionId: allow ? 'allow-once' : 'reject-once' } })
        }).connect(stream).agent
    } } })
    await harness.ctx.plugin(UserQuestions)
    harness.onElicitation = (params, signal) => { forms.push(params); return respond(signal) }
    harness.onPermission = (params) => {
      permissions.push(params)
      return { outcome: { outcome: 'selected', optionId: allow ? 'allow-once' : 'reject-once' } }
    }
    if (client === undefined) await harness.client.initialize({
      protocolVersion: 1, clientCapabilities: form ? { elicitation: { form: {} } } : {},
    })
    else await client.request('initialize', {
      protocolVersion: 2, info: { name: 'questions', version: '1' }, capabilities: form ? { elicitation: { form: {} } } : {},
    })
    const { sessionId } = client === undefined
      ? await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      : await client.request('session/new', { cwd: process.cwd() })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    return { agent, forms, permissions, reject: () => { allow = false } }
  }

  it('round-trips a negotiated form through the client and question service', async () => {
    const { agent, forms } = await connected(true)
    expect(agent.ctx.tools.get('ask_user_question', scopeOf(agent.ctx))).toBeDefined()
    await expect(harness!.ctx.userQuestions.ask({ agent, questions: [choices] })).resolves.toEqual({ answers: [{ id: '__proto__', selected: ['Read'], custom: 'Custom' }] })
    expect(forms).toEqual([expect.objectContaining({ mode: 'form', sessionId: agent.session.id, requestedSchema: questionSchema([choices]) })])
  })

  it.each(['cancel', 'decline'] as const)('returns an aborted question when the client selects %s', async (action) => {
    const { agent } = await connected(true, () => ({ action }))
    await expect(harness!.ctx.userQuestions.ask({ agent, questions: [choices] })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('propagates cancellation to the pending client form and settles the question', async () => {
    const entered = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    const { agent } = await connected(true, signal => new Promise((resolve) => {
      const finish = () => { cancelled.resolve(undefined); resolve({ action: 'cancel' }) }
      signal.addEventListener('abort', finish, { once: true })
      entered.resolve(undefined)
    }))
    const control = new AbortController()
    const answer = harness!.ctx.userQuestions.ask({ agent, questions: [choices], signal: control.signal })
    const rejected = expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await entered.promise
    control.abort(new Error('cancel test question'))
    await cancelled.promise
    await rejected
  })

  it('releases a cancelled question when the peer ignores cancellation', async () => {
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<FormResponse>()
    const { agent } = await connected(true, () => { entered.resolve(undefined); return reply.promise })
    const control = new AbortController()
    const answer = harness!.ctx.userQuestions.ask({ agent, questions: [choices], signal: control.signal })
    const rejected = expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await entered.promise
    control.abort(new Error('cancel unresponsive form'))
    await rejected
    reply.resolve({ action: 'accept', content: { q0: ['Write'] } })
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('rejects an accepted answer with labels the client was not offered', async () => {
    const { agent } = await connected(true, () => ({ action: 'accept', content: { q0: ['Delete'] } }))
    await expect(harness!.ctx.userQuestions.ask({ agent, questions: [choices] })).rejects.toMatchObject({ code: 'BAD_ANSWER' })
  })

  it('delegates to another answerer when the client does not advertise forms', async () => {
    const { agent, forms } = await connected(false)
    expect(agent.ctx.tools.get('ask_user_question', scopeOf(agent.ctx))).toBeUndefined()
    harness!.ctx.on('user-questions/request', () => Promise.resolve({ answers: [{ id: choices.id, selected: ['Write'] }] }))
    await expect(harness!.ctx.userQuestions.ask({ agent, questions: [choices] })).resolves.toEqual({ answers: [{ id: choices.id, selected: ['Write'] }] })
    expect(forms).toEqual([])
  })

  it('uses a plan-review permission even without forms and preserves allow or decline', async () => {
    const { agent, forms, permissions, reject } = await connected(false)
    const question: AskUserQuestionItem = { id: 'plan', question: 'Approve this plan?', detail: '1. Inspect\n2. Implement', options: [{ label: 'Build' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Build', callId: ToolCallId('plan-review') } }
    await expect(harness!.ctx.userQuestions.ask({ agent, questions: [question] })).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Build'] }] })
    reject()
    await expect(harness!.ctx.userQuestions.ask({ agent, questions: [question] })).resolves.toEqual({ answers: [{ id: 'plan', selected: [] }] })
    expect(forms).toEqual([])
    expect(permissions).toHaveLength(2)
    const permission = permissions[0]
    expect(permission).toMatchObject(version === 1 ? { toolCall: { kind: 'switch_mode', title: question.question } } : { subject: { type: 'tool_call', toolCall: { kind: 'switch_mode', title: question.question } } })
  })
})
