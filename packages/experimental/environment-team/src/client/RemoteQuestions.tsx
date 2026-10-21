/** Structured destination questions and one-shot approvals. */
import { useState } from 'react'
import { Button, Input, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnvironmentPendingInteraction, EnvironmentInteractionRequest } from '../interaction-types.ts'
import css from './Environments.module.css'

/** Pending request presentation and destination answer callback. */
export interface RemoteQuestionsProps extends PropsLocale<'environmentTeams'> {
  pending: EnvironmentPendingInteraction
  disabled: boolean
  answer: (value: Extract<EnvironmentInteractionRequest, { action: 'answer' }>['answer']) => void
  approve: (decision: 'allowed-once' | 'rejected') => void
}
/** Render one destination request without borrowing the local approval consumer.
 * @param props - server-issued pending request and answer actions.
 * @returns approval buttons or structured question form.
 */
export function RemoteQuestions({ pending, disabled, answer, approve, t }: RemoteQuestionsProps) {
  const [draft, setDraft] = useState<Record<string, { selected: string[]; custom: string }>>({})
  if (pending.kind === 'approval') return <article className={css.interaction}>
    <h3>{t('remoteApproval')}: {pending.toolName}</h3>
    {pending.reason && <p>{pending.reason}</p>}
    <div className={css.toolbar}><Button disabled={disabled} onClick={() => { approve('allowed-once') }}>{t('allowOnce')}</Button><Button disabled={disabled} onClick={() => { approve('rejected') }}>{t('rejectRequest')}</Button></div>
  </article>
  const answers = pending.questions.flatMap((question) => {
    const value = draft[question.id]
    return value !== undefined && (value.selected.length > 0 || value.custom.trim().length > 0) ? [{ id: question.id, ...value }] : []
  })
  const complete = answers.length === pending.questions.length
  return <article className={css.interaction}>
    {pending.questions.map((question) => {
      const value = draft[question.id] ?? { selected: [], custom: '' }
      return <fieldset key={question.id} disabled={disabled}>
        <legend>{question.header ? `${question.header}: ` : ''}{question.question}</legend>
        {question.detail && <MarkdownText text={question.detail} labels={{ code: { copyLabel: t('copyRemote'), copiedLabel: t('copiedRemote') }, footnotes: t('remoteFootnotes') }} />}
        {question.options?.map(option => <label className={css.option} key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${pending.id}:${question.id}`} checked={value.selected.includes(option.label)} onChange={(event) => {
          const selected = question.multiSelect
            ? event.target.checked ? [...value.selected, option.label] : value.selected.filter(item => item !== option.label)
            : [option.label]
          setDraft({ ...draft, [question.id]: { selected, custom: question.multiSelect ? value.custom : '' } })
        }} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
        <label>{t('customAnswer')}<Input value={value.custom} onChange={(event) => { setDraft({ ...draft, [question.id]: { selected: question.multiSelect ? value.selected : [], custom: event.target.value } }) }} /></label>
      </fieldset>
    })}
    <Button disabled={disabled || !complete} onClick={() => { answer({ answers }) }}>{t('submitAnswer')}</Button>
  </article>
}
