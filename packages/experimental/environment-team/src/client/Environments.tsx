/** Environment-scoped workspace browsing; late responses cannot change the selected machine. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Button, IconFolderCloseRegular, IconLoadingOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EnvironmentTarget, EnvironmentWorkspace, WorkspaceRequest, WorkspaceResult } from '../workspace-types.ts'
import css from './Environments.module.css'

/** Operator actions owned by the authenticated local management connection. */
export interface EnvironmentsActions {
  /** @param workspace - explicitly selected destination workspace. */
  openSessions?: (workspace: EnvironmentWorkspace) => void
  /** @returns configured installations, including unavailable peers. */
  environments: () => Promise<EnvironmentTarget[]>
  /**
   * @param environment - selected installation identity.
   * @param request - operation relative to the destination's granted directories.
   * @returns destination-owned workspace data.
   */
  workspace: (environment: EnvironmentTarget['environmentId'], request: WorkspaceRequest) => Promise<WorkspaceResult>
  /** @param kind - completed mutation or failed mutation to display in the shell. */
  notify: (kind: 'workspaceSaved' | 'workspaceFailed' | 'folderCreated') => void
}
/** Locale and asynchronous actions for the global environment panel. */
export type EnvironmentsProps = PropsLocale<'environmentTeams'> & EnvironmentsActions

/** Render the environment panel icon at the sidebar's requested size.
 * @param props - sidebar-owned icon geometry.
 * @returns the shared folder icon.
 */
export function EnvironmentsIcon({ size }: Pick<PropsRuntime<'sidebar.panellist'>, 'size'>) { return <IconFolderCloseRegular size={size} /> }

/** Browse and register workspaces on the explicitly selected installation.
 * @param props - translated copy and authenticated operations.
 * @returns the environment selector, workspace catalog, and granted-directory browser.
 */
export function Environments({ t, environments, workspace, notify, openSessions }: EnvironmentsProps) {
  const [targets, setTargets] = useState<EnvironmentTarget[]>([])
  const [selected, setSelected] = useState<EnvironmentTarget['environmentId']>()
  const [view, setView] = useState<WorkspaceResult>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [folder, setFolder] = useState('')
  const requestVersion = useRef(0)
  const mutationPending = useRef(false)
  useEffect(() => () => { requestVersion.current++ }, [])
  useEffect(() => {
    let active = true
    setLoading(true)
    void environments().then((values) => {
      if (!active) return
      setTargets(previous => values.map(value => value.status === 'unavailable' ? { ...value, label: previous.find(item => item.environmentId === value.environmentId)?.label ?? value.label } : value))
      setSelected(value => value ?? values[0]?.environmentId)
    }, () => { if (active) setError(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [environments, generation])
  useEffect(() => {
    const version = ++requestVersion.current
    if (!selected) return
    setBusy(true); setError(false)
    void workspace(selected, { action: 'catalog' }).then((result) => {
      if (version === requestVersion.current) setView(result)
    }, () => { if (version === requestVersion.current) setError(true) }).finally(() => {
      if (version === requestVersion.current) setBusy(false)
    })
    return () => { requestVersion.current++ }
  }, [selected, workspace, generation])

  const perform = async (request: WorkspaceRequest) => {
    if (!selected || mutationPending.current) return
    const version = ++requestVersion.current
    setBusy(true); setError(false)
    const mutation = request.action === 'register' || request.action === 'mkdir'
    mutationPending.current = mutation
    setMutating(mutation)
    try {
      const result = await workspace(selected, request)
      if (version !== requestVersion.current) return
      if (mutation) notify(request.action === 'register' ? 'workspaceSaved' : 'folderCreated')
      setView(result); setFolder('')
    } catch {
      if (version !== requestVersion.current) return
      if (mutation) notify('workspaceFailed')
      else setError(true)
    } finally {
      mutationPending.current = false
      if (version === requestVersion.current) { setBusy(false); setMutating(false) }
    }
  }
  const selectedTarget = targets.find(item => item.environmentId === selected)
  return <section className={css.page} aria-busy={busy || loading}>
    <header className={css.header}><div><h1>{t('environments')}</h1><p>{t('environmentsHelp')}</p></div><Button disabled={busy || loading} onClick={() => { setGeneration(value => value + 1) }}>{t('refresh')}</Button></header>
    <div className={css.selector}><label>{t('machine')}<select value={selected ?? ''} disabled={mutating} onChange={(event) => {
      const target = targets.find(item => item.environmentId === event.target.value)
      if (target) { requestVersion.current++; setSelected(target.environmentId); setView(undefined); setFolder(''); setError(false) }
    }}>{targets.map(item => <option key={item.environmentId} value={item.environmentId}>{item.label} · {t(item.local ? 'thisMachine' : item.status)}</option>)}</select></label>
    {selectedTarget && <code>{selectedTarget.environmentId}</code>}</div>
    {error && <p role="alert" className={css.error}>{t('workspaceReadFailed')}</p>}
    {!view && (busy || loading) && <div className={css.loading}><IconLoadingOutlineRegular /></div>}
    {view?.kind === 'catalog' && <>
      <h2>{t('registeredWorkspaces')}</h2>
      {view.workspaces.length === 0 && <p>{t('noWorkspaces')}</p>}
      {view.workspaces.map(item => <div className={css.row} key={`${item.environmentId}:${item.workspaceId}`}><div><strong>{item.title}</strong><code>{item.path}</code></div><div>{openSessions && <Button disabled={busy} onClick={() =>{  openSessions(item) }}>{t('openSessions')}</Button>}<Button disabled={busy} onClick={() => { void perform({ action: 'browse', alias: item.alias, relativePath: item.relativePath }) }}>{t('browse')}</Button></div></div>)}
      <h2>{t('grantedDirectories')}</h2>
      {view.roots.length === 0 && <p>{t('noGrantedDirectories')}</p>}
      {view.roots.map(root => <div className={css.row} key={root.alias}><div><strong>{root.alias}</strong><code>{root.path}</code></div><Button disabled={busy} onClick={() => { void perform({ action: 'browse', alias: root.alias, relativePath: '' }) }}>{t('browse')}</Button></div>)}
      {view.truncated && <p>{t('truncated')}</p>}
    </>}
    {view?.kind === 'directory' && <>
      <div className={css.toolbar}><Button disabled={busy} onClick={() => { void perform({ action: 'catalog' }) }}>{t('allWorkspaces')}</Button><Button disabled={busy || !view.relativePath} onClick={() => { void perform({ action: 'browse', alias: view.alias, relativePath: view.relativePath.split('/').slice(0, -1).join('/') }) }}>{t('parentDirectory')}</Button></div>
      <code className={css.path}>{view.path}</code>
      <Button variant="primary" disabled={busy} onClick={() => { void perform({ action: 'register', alias: view.alias, relativePath: view.relativePath }) }}>{t('useDirectory')}</Button>
      <div className={css.toolbar}><label>{t('newFolderName')}<Input value={folder} disabled={busy} onChange={(event) => { setFolder(event.target.value) }} /></label><Button disabled={busy || !folder.trim()} onClick={() => { void perform({ action: 'mkdir', alias: view.alias, relativePath: view.relativePath, name: folder }) }}>{t('createFolder')}</Button></div>
      {view.entries.length === 0 && <p>{t('noSubdirectories')}</p>}
      {view.entries.map(entry => <div className={css.row} key={entry.relativePath}><span>{entry.name}</span><Button disabled={busy} onClick={() => { void perform({ action: 'browse', alias: view.alias, relativePath: entry.relativePath }) }}>{t('browse')}</Button></div>)}
      {view.truncated && <p>{t('truncated')}</p>}
    </>}
    {view?.kind === 'registered' && <><h2>{view.workspace.title}</h2><code className={css.path}>{view.workspace.path}</code><p>{t('registeredOnMachine')}</p>{openSessions && <Button onClick={() =>{  openSessions(view.workspace) }}>{t('openSessions')}</Button>}<Button disabled={busy} onClick={() => { void perform({ action: 'catalog' }) }}>{t('allWorkspaces')}</Button></>}
  </section>
}
