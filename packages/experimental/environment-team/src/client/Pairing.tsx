/** Private invitation transfer and explicit grants in the existing Plugins configuration surface. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnvironmentConfiguration } from '../settings-types.ts'
import type { PairingGrants, PairingInvitation, PairingInvitationMetadata, PairingInvitationId, PairingReceipt, PairingAttemptMetadata } from '../pairing-types.ts'
import css from './Page.module.css'

/** Authenticated invitation operations; credential material is never read from inventory. */
export interface PairingActions {
  pairingCreate(grants: PairingGrants): Promise<PairingInvitation>
  pairingList(this: void): Promise<PairingInvitationMetadata[]>
  pairingRevoke(id: PairingInvitationId): Promise<void>
  pairingAccept(invitation: string, grants: PairingGrants): Promise<PairingReceipt>
  pairingAttempts(this: void): Promise<PairingAttemptMetadata[]>
  pairingForget(id: PairingInvitationId): Promise<void>
  notify(kind: 'pairingChanged' | 'pairingFailed'): void
}

const permissions = [
  ['workspaceManagement', 'pairingWorkspaceManagement'], ['sessionAccess', 'pairingSessionAccess'],
  ['attachmentAccess', 'pairingAttachmentAccess'], ['approvalAccess', 'pairingApprovalAccess'],
  ['terminalAccess', 'pairingTerminalAccess'], ['teamAccess', 'pairingTeamAccess'], ['teamOperate', 'pairingTeamOperate'],
] as const
const statuses = { pending: 'pairingPending', redeeming: 'pairingRedeeming', consumed: 'pairingConsumed', revoked: 'pairingRevoked', expired: 'pairingExpired' } as const

/** Render grants and private transfer fields without persisting invitation tokens in browser storage.
 * @param props - saved configuration, localized copy and operator actions.
 * @returns invitation form and redacted invitation inventory.
 */
export function Pairing(props: PairingActions & PropsLocale<'environmentTeams'> & { configuration: EnvironmentConfiguration; changed: () => void }) {
  const { t } = props
  const generatedId = useRef<PairingInvitationId | undefined>(undefined)
  const consumed = useRef<Set<string>>(new Set())
  const changed = useRef(props.changed)
  changed.current = props.changed
  const [mode, setMode] = useState<'generate' | 'enter'>('generate')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [incoming, setIncoming] = useState('')
  const [outgoing, setOutgoing] = useState<{ code: string; expiresAt: number }>()
  const [items, setItems] = useState<PairingInvitationMetadata[]>()
  const [attempts, setAttempts] = useState<PairingAttemptMetadata[]>()
  const [readFailed, setReadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [grants, setGrants] = useState<PairingGrants>({
    workspaces: [], workspaceManagement: false, sessionAccess: false, attachmentAccess: false,
    approvalAccess: false, terminalAccess: false, teamAccess: false, teamOperate: false,
  })
  useEffect(() => {
    let active = true
    void Promise.all([props.pairingList(), props.pairingAttempts()]).then(([value, pending]) => {
      if (active) {
        const newlyConnected = value.some((item) => {
          const target = item.target
          return item.status === 'consumed' && !consumed.current.has(item.id) && target !== undefined && !props.configuration.config.peers.some(peer => peer.environmentId === target.environmentId)
        })
        consumed.current = new Set(value.filter(item => item.status === 'consumed').map(item => item.id))
        setItems(value); setAttempts(pending); setReadFailed(false)
        if (value.some(item => item.id === generatedId.current && item.status !== 'pending' && item.status !== 'redeeming')) setOutgoing(undefined)
        if (newlyConnected) changed.current()
      }
    }, () => { if (active) setReadFailed(true) })
    return () => { active = false }
  }, [generation, props.pairingList, props.pairingAttempts, props.configuration.config.peers])
  useEffect(() => {
    if (!outgoing) return
    const timer = setInterval(() => {
      const time = Date.now()
      setNow(time); setGeneration(value => value + 1)
      if (time >= outgoing.expiresAt) clearInterval(timer)
    }, props.configuration.config.sessionSyncIntervalMs)
    return () => { clearInterval(timer) }
  }, [outgoing, props.configuration.config.sessionSyncIntervalMs])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    try { await operation(); setGeneration(value => value + 1); props.notify('pairingChanged') }
    catch { props.notify('pairingFailed') }
    finally { setBusy(false) }
  }
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(true) }
    catch { props.notify('pairingFailed') }
  }
  const create = () => {
    void run(async () => {
      const invitation = await props.pairingCreate(grants)
      generatedId.current = invitation.id
      const bytes = new TextEncoder().encode(JSON.stringify(invitation))
      setOutgoing({ code: `dsh-pair:${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`, expiresAt: invitation.expiresAt })
      setNow(Date.now()); setCopied(false)
    })
  }
  return <section className={css.pairing}>
    <h3>{t('pairingTitle')}</h3><p>{t('pairingHelp')}</p>
    {!props.configuration.config.publicUrl && <p role="status">{t('pairingNeedsUrl')}</p>}
    <div className={css.actions}>
      <Button disabled={busy} aria-pressed={mode === 'generate'} onClick={() => { setMode('generate') }}>{t('pairingGenerateMode')}</Button>
      <Button disabled={busy} aria-pressed={mode === 'enter'} onClick={() => { setMode('enter') }}>{t('pairingEnterMode')}</Button>
    </div>
    <p>{t(mode === 'generate' ? 'pairingGenerateHelp' : 'pairingEnterHelp')}</p>
    <fieldset disabled={busy || !props.configuration.config.publicUrl} className={css.fields}>
      <h3>{t('pairingPermissions')}</h3><span>{t('pairingWorkspaces')}</span>
      {Object.keys(props.configuration.config.workspaces).length === 0 && <p>{t('pairingNoWorkspaces')}</p>}
      {Object.keys(props.configuration.config.workspaces).map(alias => <label key={alias}>
        <input type="checkbox" checked={grants.workspaces.includes(alias)} onChange={(event) => { setGrants({ ...grants, workspaces: event.target.checked ? [...grants.workspaces, alias] : grants.workspaces.filter(value => value !== alias) }) }} />{alias}
      </label>)}
      {permissions.map(([key, label]) => <label key={key}><input type="checkbox" checked={grants[key]} onChange={(event) => {
        const checked = event.target.checked
        setGrants({ ...grants, [key]: checked, ...(key === 'teamOperate' && checked ? { teamAccess: true } : {}), ...(key === 'teamAccess' && !checked ? { teamOperate: false } : {}) })
      }} />{t(label)}</label>)}
      {mode === 'generate' ? <>
        <p>{t('pairingLifetime')}: {props.configuration.config.invitationLifetimeMs / 60000} {t('pairingMinutes')}</p>
        <div><Button onClick={create}>{t('pairingCreate')}</Button></div>
        {outgoing && <>
          <label className={css.field}>{t('pairingOutput')}<textarea className={css.transfer} readOnly value={outgoing.code} /></label>
          {now >= outgoing.expiresAt && <p role="status">{t('pairingExpired')}</p>}
          <p>{t('pairingExpiresAt')}: {new Date(outgoing.expiresAt).toLocaleString()}</p>
          <div className={css.actions}><Button disabled={now >= outgoing.expiresAt} onClick={() => { void copy(outgoing.code) }}>{t(copied ? 'copiedRemote' : 'pairingCopy')}</Button><Button onClick={() => { setOutgoing(undefined) }}>{t('pairingHide')}</Button></div>
        </>}
      </> : <>
        <label className={css.field}>{t('pairingInput')}<textarea className={css.transfer} value={incoming} onChange={(event) => { setIncoming(event.target.value) }} /></label>
        <p>{t('pairingRetryHelp')}</p>
        <div><Button disabled={!incoming.trim()} onClick={() => { void run(async () => { await props.pairingAccept(incoming.trim(), grants); setIncoming(''); props.changed() }) }}>{t('pairingAccept')}</Button></div>
      </>}
    </fieldset>
    {readFailed && <p role="alert">{t('pairingLoadingFailed')}</p>}
    {!items && !readFailed && <div className={css.loading}><IconLoadingOutlineRegular /></div>}
    {items?.length === 0 && attempts?.length === 0 && <p>{t('pairingEmpty')}</p>}
    {attempts?.map(attempt => <div className={css.peer} key={attempt.id}>
      <code>{attempt.issuer.environmentId}</code><span>{attempt.issuer.url}</span>
      <span>{t(attempt.status === 'complete' ? 'pairingConsumed' : 'pairingRedeeming')}</span>
      {!props.configuration.config.peers.some(peer => peer.environmentId === attempt.issuer.environmentId) && <div><Button disabled={busy} onClick={() => { void run(async () => { await props.pairingForget(attempt.id) }) }}>{t('pairingForget')}</Button></div>}
    </div>)}
    {items?.map(item => <div className={css.peer} key={item.id}>
      {item.target ? <><code>{item.target.environmentId}</code><span>{item.target.url}</span></> : <span>{t('pairingUnclaimed')}</span>}<span>{t(statuses[item.status])}</span>
      {(item.status === 'pending' || item.status === 'redeeming') && <div><Button disabled={busy} onClick={() => { void run(async () => { await props.pairingRevoke(item.id) }) }}>{t('pairingRevoke')}</Button></div>}
    </div>)}
    <Button disabled={busy} onClick={() => { setGeneration(value => value + 1) }}>{t('pairingRefresh')}</Button>
  </section>
}
