/** Localized Plugins page for machine routes, local checkouts, and worker defaults. */
import { useEffect, useState } from 'react'
import { Button, Input, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { EnvironmentConfiguration } from '../settings-types.ts'
import type { EnvironmentTeamConfig } from '../config-types.ts'
import type { EnvironmentSettingsKey } from './locales.ts'
import css from './Page.module.css'

/** Authenticated operations supplied by the browser plugin owner. */
export interface PageActions {
  /** Publish completed save feedback outside the page. */
  notify(kind: 'saved' | 'saveFailed'): void
  /** Read this installation's deployment values. */
  read: () => Promise<EnvironmentConfiguration>
  /** Persist all deployment values and reload the runtime. */
  save(value: EnvironmentConfiguration): Promise<EnvironmentConfiguration>
  /** Store a write-only pairing credential. */
  credential(reference: string, value: string): Promise<void>
}
/** Props supplied by the Plugins slot and locale owner. */
export type PageProps = Pick<PropsRuntime<'plugins.bundle.config'>, 'view'> & PropsLocale<'environmentTeams'> & PageActions

const scalarFields = ['label', 'provider', 'model', 'agentPreset'] as const
const limits = ['requestTimeoutMs', 'retryIntervalMs', 'maxBytes', 'maxTeams', 'maxMembers', 'maxTasks', 'maxOperations', 'workspacePageSize'] as const

/** Render editable deployment values without embedding credentials in saved configuration.
 * @param props - localized copy and authenticated profile operations.
 * @returns the configuration form or a loading/error state.
 */
export function Page(props: PageProps) {
  const { t } = props
  const [accepted, setAccepted] = useState<EnvironmentConfiguration>()
  const [draft, setDraft] = useState<EnvironmentConfiguration['config']>()
  const [workspaces, setWorkspaces] = useState<Array<{ alias: string; path: string }>>([])
  const [secrets, setSecrets] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (props.view === 'summary') return
    let active = true
    void props.read().then((value) => {
      if (!active) return
      setAccepted(value); setDraft(value.config)
      setWorkspaces(Object.entries(value.config.workspaces).map(([alias, path]) => ({ alias, path })))
      setSecrets({}); setError('')
    }, () => { if (active) setError(t('loadingFailed')) })
    return () => { active = false }
  }, [generation, props.read, props.view, t])
  if (props.view === 'summary') return t('description')
  if (!accepted || !draft) return error ? <div role="alert">{error}<Button onClick={() => { setGeneration(value => value + 1) }}>{t('reload')}</Button></div> : <div className={css.loading}><IconLoadingOutlineRegular /></div>
  const peers = draft.peers
  const field = (key: EnvironmentSettingsKey, value: string, edit: (value: string) => void, type = 'text') => (
    <label className={css.field}>
      <span>{t(key)}</span>
      <Input type={type} value={value} disabled={busy} onChange={(event) => { edit(event.target.value) }} />
    </label>
  )
  const updatePeer = (index: number, change: Partial<NonNullable<EnvironmentTeamConfig['peers']>[number]>) => {
    setDraft({ ...draft, peers: peers.map((peer, i) => i === index ? { ...peer, ...change } : peer) })
  }
  const save = async () => {
    if (workspaces.some(item => !item.alias) || new Set(workspaces.map(item => item.alias)).size !== workspaces.length) {
      setError(t('invalidWorkspace')); return
    }
    if (limits.some((key) => { const value = draft[key]; return !Number.isSafeInteger(value) || value < 1 })) {
      setError(t('invalidNumber')); return
    }
    setBusy(true); setError('')
    try {
      for (const [index, peer] of peers.entries()) {
        const secret = secrets[index]
        if (secret) await props.credential(peer.tokenEnv, secret)
      }
      const config = { ...draft, workspaces: Object.fromEntries(workspaces.map(item => [item.alias, item.path])) }
      const result = await props.save({ ...accepted, config })
      setAccepted(result); setDraft(result.config); setSecrets({}); props.notify('saved')
    } catch { props.notify('saveFailed') } finally { setBusy(false) }
  }
  return <div className={css.page}>
    <p>{t('coordinator')}</p><p>{t('identity')}: <code>{accepted.environmentId}</code></p>
    <fieldset disabled={busy} className={css.fields}>
      {scalarFields.map(key => <div key={key}>{field(key, draft[key], (value) => { setDraft({ ...draft, [key]: value }) })}</div>)}
      <label className={css.field}>{t('sandboxMode')}<select value={draft.sandboxMode} onChange={(event) => { setDraft({ ...draft, sandboxMode: event.target.value as EnvironmentTeamConfig['sandboxMode'] }) }}>{(['read-only', 'workspace-write', 'danger-full-access'] as const).map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>
      <label className={css.field}>{t('approvalPolicy')}<select value={draft.approvalPolicy} onChange={(event) => { setDraft({ ...draft, approvalPolicy: event.target.value as EnvironmentTeamConfig['approvalPolicy'] }) }}>{(['ask', 'never'] as const).map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>
      <h3>{t('workspaces')}</h3>
      {workspaces.map((item, index) => <div className={css.row} key={index}>
        {field('alias', item.alias, (value) => { setWorkspaces(workspaces.map((row, i) => i === index ? { ...row, alias: value } : row)) })}
        {field('path', item.path, (value) => { setWorkspaces(workspaces.map((row, i) => i === index ? { ...row, path: value } : row)) })}
        <Button onClick={() => { setWorkspaces(workspaces.filter((_, i) => i !== index)) }}>{t('remove')}</Button>
      </div>)}
      <Button onClick={() => { setWorkspaces([...workspaces, { alias: '', path: '' }]) }}>{t('addWorkspace')}</Button>
      <h3>{t('peers')}</h3><p>{t('secretHelp')}</p>
      {peers.map((peer, index) => <div className={css.peer} key={index}>
        {field('environmentId', peer.environmentId, (value) => { updatePeer(index, { environmentId: value, tokenEnv: `DSH_PEER_${value.replaceAll('-', '_')}` }) })}
        {field('url', peer.url, (value) => { updatePeer(index, { url: value }) })}
        {field('grants', peer.workspaces.join(', '), (value) => { updatePeer(index, { workspaces: value.split(',').map(item => item.trim()) }) })}
        <label><input type="checkbox" checked={peer.workspaceManagement ?? false} onChange={(event) => { updatePeer(index, { workspaceManagement: event.target.checked }) }} />{t('workspaceManagement')}</label>
        {field('secret', secrets[index] ?? '', (value) => { setSecrets({ ...secrets, [index]: value }) }, 'password')}
        <Button onClick={() => { setDraft({ ...draft, peers: peers.filter((_, i) => i !== index) })
          setSecrets(Object.fromEntries(Object.entries(secrets).filter(([key]) => Number(key) !== index).map(([key, value]) => [Number(key) > index ? Number(key) - 1 : Number(key), value]))) }}>{t('remove')}</Button>
      </div>)}
      <Button onClick={() => { setDraft({ ...draft, peers: [...peers, { environmentId: '', url: '', tokenEnv: '', workspaces: [] }] }) }}>{t('addPeer')}</Button>
      <details><summary>{t('limits')}</summary>{limits.map(key => <div key={key}>{field(key, String(draft[key]), (value) => { setDraft({ ...draft, [key]: Number(value) }) }, 'number')}</div>)}</details>
    </fieldset>
    <p>{t('changed')}</p>{error && <p role="alert">{error}</p>}
    <div className={css.actions}><Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('save')}</Button><Button disabled={busy} onClick={() => { setGeneration(value => value + 1) }}>{t('reload')}</Button></div>
  </div>
}
