/** Coordinator roster, task board and durable delivery metadata. */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconFolderCloseRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamState } from './team-controller.ts'
import css from './Environments.module.css'

/** Dashboard state and explicit coordinator operations. */
export interface TeamsFace {
  hooks: { remoteTeams: SnapshotStore<TeamState> }
  resume(): void
  pause(): void
  refresh(): void
  selectEnvironment(id: NonNullable<TeamState['environmentId']>): void
  selectTeam(id: NonNullable<TeamState['teamId']>): void
  interrupt(id: NonNullable<TeamState['detail']>['members'][number]['sessionId']): void
}
/** Render the shared sidebar icon.
 * @param props - sidebar-owned geometry.
 * @returns a shared folder icon.
 */
export function TeamsIcon({ size }: Pick<PropsRuntime<'sidebar.panellist'>, 'size'>) { return <IconFolderCloseRegular size={size} /> }

/** Display coordinator-owned data without selecting or activating a local conversation.
 * @param props - translated copy, observable state and operator actions.
 * @returns destination selection, team roster, tasks and queued delivery metadata.
 */
export function Teams(props: PropsLocale<'environmentTeams'> & InjectFace<TeamsFace>) {
  const { t, resume, pause } = props
  const state = props.useRemoteTeams(value => value)
  useEffect(() => { resume(); return pause }, [resume, pause])
  return <section className={css.page} aria-busy={state.loading || state.busy}>
    <header className={css.header}><div><h1>{t('teamDashboard')}</h1><p>{t('teamDashboardHelp')}</p></div>
      <Button disabled={state.busy} onClick={props.refresh}>{t('refresh')}</Button></header>
    <div className={css.selector}><label>{t('machine')}<select value={state.environmentId ?? ''} disabled={state.busy} onChange={(event) => {
      const target = state.targets.find(item => item.environmentId === event.target.value)
      if (target) props.selectEnvironment(target.environmentId)
    }}>{state.targets.map(item => <option key={item.environmentId} value={item.environmentId}>{item.label} · {t(item.local ? 'thisMachine' : item.status)}</option>)}</select></label>
    <code>{state.environmentId}</code></div>
    {state.offline && <p role="alert">{t('teamReadFailed')}</p>}
    {state.loading && !state.catalog && <div className={css.loading}><IconLoadingOutlineRegular /></div>}
    <h2>{t('teamCatalog')}</h2>
    {state.catalog?.teams.length === 0 && <p>{t('noDistributedTeams')}</p>}
    {state.catalog?.teams.map(team => <div className={css.row} key={team.teamId}>
      <div><code>{team.teamId}</code><span>{t('teamWorkspace')}: {team.workspace}</span>
        <span>{t('teamRoster')}: {team.members} · {t('teamTasks')}: {team.tasks} · {t('teamOutbox')}: {team.queuedMessages}</span></div>
      <Button disabled={state.busy} aria-pressed={state.teamId === team.teamId} onClick={() => { props.selectTeam(team.teamId) }}>{t('openTeam')}</Button>
    </div>)}
    {state.detail && <>
      <h2>{t('teamRoster')}</h2>
      {state.detail.members.map(member => <div className={css.row} key={`${member.environmentId}:${member.sessionId}`}>
        <div><strong>{member.name}</strong><code>{member.environmentId}</code><code>{member.sessionId}</code>
          <span>{member.workspace}</span></div>
        {member.name !== 'lead' && <Button disabled={state.busy} onClick={() => { props.interrupt(member.sessionId) }}>
          {t('teamInterrupt')}</Button>}
      </div>)}
      <h2>{t('teamTasks')}</h2>
      {state.detail.tasks.length === 0 && <p>{t('teamNoTasks')}</p>}
      {state.detail.tasks.map(task => <article className={css.row} key={task.id}><div><strong>{task.text}</strong>
        <span>{t(task.status === 'pending' ? 'teamPending' : task.status === 'in_progress' ? 'teamInProgress' : 'teamCompleted')} · {t('teamRevision')}: {task.revision}</span>
        {task.owner && <span>{t('teamOwner')}: {task.owner}</span>}</div></article>)}
      <h2>{t('teamOutbox')}</h2>
      {state.detail.outbox.length === 0 && <p>{t('teamNoDeliveries')}</p>}
      {state.detail.outbox.map(message => <div className={css.row} key={message.id}><code>{message.id}</code>
        <span>{t('teamSender')}: {message.sender} · {t('teamTarget')}: {message.target}</span></div>)}
    </>}
  </section>
}
