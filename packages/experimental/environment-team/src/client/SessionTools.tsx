/** Remote attachments, questions, tool details and interactive terminals. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnvironmentSessionAttachment, EnvironmentTerminalFollowRequest } from '../interaction-types.ts'
import type { InteractionState, InteractionCommand } from './interaction-controller.ts'
import { RemoteQuestions } from './RemoteQuestions.tsx'
import { RemoteTerminal } from './RemoteTerminal.tsx'
import css from './Environments.module.css'

/** Browser controls route only through the selected destination owner. */
export interface SessionToolsActions {
  interaction: (request: InteractionCommand) => void
  upload: (file: File) => void
  download: (attachment: EnvironmentSessionAttachment) => void
  terminalConnect: (id: EnvironmentTerminalFollowRequest['terminalId']) => void
  terminalCreate: (cols: number, rows: number) => void
  terminalWrite: (data: string) => void
  terminalRendered: (revision: number) => void
}
/** Render retained destination data and explicitly scoped controls.
 * @param props - destination state, localized copy and operation callbacks.
 * @returns conversation accessory controls.
 */
export function SessionTools({ state, disabled, t, ...actions }: PropsLocale<'environmentTeams'> & SessionToolsActions & { state: InteractionState; disabled: boolean }) {
  const [cols, setCols] = useState('')
  const [rows, setRows] = useState('')
  const snapshot = state.snapshot
  const columns = cols || String(snapshot?.terminalCols ?? '')
  const lines = rows || String(snapshot?.terminalRows ?? '')
  const locked = disabled || state.busy
  const sizeValid = Number.isSafeInteger(Number(columns)) && Number(columns) >= 2
    && Number.isSafeInteger(Number(lines)) && Number(lines) >= 1
  const terminal = state.terminal
  return <div>
    {state.offline && <p role="alert">{t('interactionOffline')}</p>}
    {snapshot?.pending.map(pending => <RemoteQuestions key={pending.id} pending={pending} disabled={locked} t={t}
      approve={(decision) => { actions.interaction({ action: 'approval', id: pending.id, decision }) }}
      answer={(answer) => { actions.interaction({ action: 'answer', id: pending.id, answer }) }} />)}
    {snapshot?.capabilities.attachments && <label className={css.composer}>{t('attachFile')}<input type="file" disabled={locked} onChange={(event) => {
      const file = event.target.files?.[0]
      if (file) actions.upload(file)
      event.target.value = ''
    }} /></label>}
    {snapshot && !snapshot.capabilities.attachments && <p>{t('attachmentsDisabled')}</p>}
    {snapshot?.attachments.map(attachment => <div className={css.row} key={attachment.attachmentId}><span>{attachment.name} · {attachment.bytes} {t('remoteBytes')}</span><Button disabled={locked} onClick={() => { actions.download(attachment) }}>{t('downloadFile')}</Button></div>)}
    {snapshot?.details.length ? <details><summary>{t('toolDetails')}</summary>{snapshot.details.map(detail => <article key={`${detail.seq}:${detail.kind}`} className={css.interaction}><strong>{detail.title}</strong><pre>{detail.text}</pre>{detail.isError && <p role="alert">{t('remoteOperationError')}</p>}</article>)}</details> : null}
    {snapshot?.truncated && <p>{t('detailsTruncated')}</p>}
    {snapshot?.capabilities.terminals && <section>
      <h2>{t('remoteTerminals')}</h2>
      {snapshot.terminals.map(terminal => <div key={terminal.id} className={css.row}><span>{terminal.title} · {t(terminal.state === 'running' ? 'sessionRunning' : terminal.state === 'exited' ? 'terminalExited' : 'terminalFailed')}</span><div><Button disabled={locked} onClick={() => { actions.terminalConnect(terminal.id) }}>{t('openTerminal')}</Button><Button disabled={locked} onClick={() => { actions.interaction({ action: 'terminal-close', terminalId: terminal.id }) }}>{t('closeTerminal')}</Button></div></div>)}
      <div className={css.toolbar}><label>{t('terminalColumns')}<Input type="number" min={2} value={columns} onChange={(event) => { setCols(event.target.value) }} /></label><label>{t('terminalRowsLabel')}<Input type="number" min={1} value={lines} onChange={(event) => { setRows(event.target.value) }} /></label><Button disabled={locked || !sizeValid} onClick={() => { actions.terminalCreate(Number(columns), Number(lines)) }}>{t('newTerminal')}</Button>
        {terminal && <Button disabled={locked || !sizeValid} onClick={() => { actions.interaction({ action: 'terminal-resize', ...terminal, cols: Number(columns), rows: Number(lines) }) }}>{t('resizeTerminal')}</Button>}
      </div>
      {state.terminalOffline && <p role="alert">{t('terminalOffline')}</p>}
      {state.terminalInfo && state.terminalInfo.controllerId !== terminal?.attachmentId && <p>{t('terminalReadOnly')}</p>}
      {state.terminal && <RemoteTerminal identity={`${state.address?.environmentId}:${state.terminal.attachmentId}`} frame={state.terminalFrame} revision={state.terminalRevision} label={t('terminalInput')} failureLabel={t('terminalFailed')} disabled={state.terminalOffline || state.terminalInfo?.controllerId !== terminal?.attachmentId || disabled} write={actions.terminalWrite} rendered={actions.terminalRendered} />}
    </section>}
  </div>
}
