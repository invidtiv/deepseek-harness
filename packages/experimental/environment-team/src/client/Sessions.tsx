/** Destination session catalog, durable messages and live assistant text. */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconLoadingOutlineRegular, IconNewChatOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EnvironmentWorkspace } from '../workspace-types.ts'
import type { RemoteSessionState } from './session-controller.ts'
import type { InteractionState } from './interaction-controller.ts'
import { SessionTools, type SessionToolsActions } from './SessionTools.tsx'
import css from './Environments.module.css'

/** Session panel data source and destination-owned actions. */
export interface SessionsFace extends SessionToolsActions {
  hooks: { remoteSessions: SnapshotStore<RemoteSessionState>; remoteInteractions: SnapshotStore<InteractionState> }
  resume(): void
  pause(): void
  openWorkspace(workspace: EnvironmentWorkspace): void
  earlier(): void
  backToLive(): void
  back(): void
  refresh(): void
  create(): void
  select(id: NonNullable<RemoteSessionState['sessionId']>): void
  draft(text: string): void
  send(): void
  cancel(): void
  removeAttachment(index: number): void
}
/** Render registered workspace sessions without changing the local Session selection.
 * @param props - observable state, translated copy and destination actions.
 * @returns synchronized catalog, committed transcript and text composer.
 */
export function Sessions(props: PropsLocale<'environmentTeams'> & InjectFace<SessionsFace>) {
  const { t, resume, pause } = props
  const state = props.useRemoteSessions(value => value)
  const interactions = props.useRemoteInteractions(value => value)
  const displayed = state.history ?? state.transcript
  const markdownLabels = { code: { copyLabel: t('copyRemote'), copiedLabel: t('copiedRemote') }, footnotes: t('remoteFootnotes') }
  useEffect(() => { resume(); return pause }, [resume, pause])
  return <section className={css.page} aria-busy={state.loading || state.busy}>
    <header className={css.header}><div><h1>{state.workspace?.title ?? t('remoteSessions')}</h1><p>{t('sessionSyncHelp')}</p><code>{state.workspace?.environmentId}</code></div><Button disabled={state.busy} onClick={props.back}>{t('allWorkspaces')}</Button></header>
    {!state.workspace && <p>{t('selectRemoteWorkspace')}</p>}
    {!!state.recentWorkspaces?.length && <label className={css.selector}>{t('recentRemoteWorkspaces')}<select disabled={state.busy} value={state.workspace ? `${state.workspace.environmentId}:${state.workspace.workspaceId}` : ''} onChange={(event) => {
      const workspace = state.recentWorkspaces?.find(item => `${item.environmentId}:${item.workspaceId}` === event.target.value)
      if (workspace) props.openWorkspace(workspace)
    }}>{state.recentWorkspaces.map(workspace => <option key={`${workspace.environmentId}:${workspace.workspaceId}`} value={`${workspace.environmentId}:${workspace.workspaceId}`}>{workspace.title} · {workspace.environmentId}</option>)}</select></label>}
    <div className={css.toolbar}><Button disabled={state.busy} onClick={props.refresh}>{t('refresh')}</Button><Button disabled={state.busy || !state.workspace} onClick={props.create}>{t('newSession')}</Button>{state.webUrl && <a href={state.webUrl} target="_blank" rel="noopener noreferrer">{t('openDestination')}</a>}</div>
    {state.streamFailure ? <p role="alert">{t(state.streamFailure)}</p> : state.offline && <p role="alert">{t('sessionOffline')}</p>}
    {state.loading && !state.list && <div className={css.loading}><IconLoadingOutlineRegular /></div>}
    {state.list?.sessions.length === 0 && <p>{t('noRemoteSessions')}</p>}
    {state.list?.sessions.map(session => <div className={css.row} key={session.sessionId}><div><strong>{session.title}</strong><span>{t(session.running ? 'sessionRunning' : 'sessionIdle')}</span></div><Button disabled={state.busy} aria-pressed={session.sessionId === state.sessionId} onClick={() =>{  props.select(session.sessionId) }}>{t('openSession')}</Button></div>)}
    {state.list?.truncated && <p>{t('sessionsTruncated')}</p>}
    {state.sessionId && <>
      <h2>{t('sessionMessages')}</h2>
      {state.loading && !state.transcript && <div className={css.loading}><IconLoadingOutlineRegular /></div>}
      {state.history && <p role="status">{t('viewingSessionHistory')}</p>}
      {state.historyUnsupported && <p role="alert">{t('historyUnsupported')}</p>}
      {(displayed?.truncated || state.history || state.historyLoading) && <div className={css.toolbar}>
        {displayed?.truncated && <Button disabled={state.busy || state.historyLoading || state.historyUnsupported} onClick={props.earlier}>{t('earlierMessages')}</Button>}
        {(state.history || state.historyLoading) && <Button onClick={props.backToLive}>{t('returnToLive')}</Button>}
      </div>}
      {state.historyLoading && <div className={css.loading}><IconLoadingOutlineRegular /></div>}
      {displayed?.messages.length === 0 && <p>{t(state.history ? 'noEarlierMessages' : 'noSessionMessages')}</p>}
      <div className={css.messages}>{displayed?.messages.map(message => <article key={message.seq}><strong>{t(message.role === 'user' ? 'sessionUser' : 'sessionAssistant')}</strong><MarkdownText text={message.text} labels={markdownLabels} /></article>)}</div>
      {!state.history && state.transcript?.live && <div className={css.messages}><article><strong>{t('sessionAssistant')} · {t('sessionStreaming')}</strong><MarkdownText text={state.transcript.live.text} streaming labels={markdownLabels} /></article></div>}
      {!state.history && displayed?.truncated && <p>{t('messagesTruncated')}</p>}
      <label className={css.composer}>{t('sessionMessage')}<textarea value={state.draft} disabled={state.busy || state.uncertain} onChange={(event) =>{  props.draft(event.target.value) }} rows={4} /></label>
      {state.attachments?.map((attachment, index) => <div className={css.row} key={index}><span>{attachment.name}</span><Button disabled={state.busy || state.uncertain} onClick={() => { props.removeAttachment(index) }}>{t('remove')}</Button></div>)}
      {state.uncertain && <p role="alert">{t('sessionUncertain')}</p>}
      <div className={css.toolbar}><Button variant="primary" disabled={state.busy || interactions.busy || (!state.draft.trim() && !state.attachments?.length)} onClick={props.send}>{t(state.uncertain ? 'retryMessage' : 'sendMessage')}</Button><Button disabled={state.busy || !state.transcript?.running} onClick={props.cancel}>{t('stopSession')}</Button></div>
      <SessionTools {...props} state={interactions} disabled={state.busy || state.uncertain} />
    </>}
  </section>
}

/** Sidebar entry for destination-owned conversations.
 * @returns the shared conversation icon.
 */
export function SessionsIcon() { return <IconNewChatOutlineRegular /> }
