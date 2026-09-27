/** Private invitation transfer and explicit grants in the existing Plugins configuration surface. */
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Button, Input, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnvironmentConfiguration } from '../settings-types.ts'
import type { PairingTarget, PairingGrants, PairingInvitation, PairingInvitationMetadata, PairingInvitationId, PairingReceipt, PairingAttemptMetadata } from '../pairing-types.ts'
import css from './Page.module.css'

/** Authenticated invitation operations; credential material is never read from inventory. */
export interface PairingActions {
  pairingCreate(target: PairingTarget, grants: PairingGrants): Promise<PairingInvitation>
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
export function Pairing(props: PairingActions & PropsLocale<'environmentTeams'> & { configuration: EnvironmentConfiguration; changed(): void }) {
  const { t } = props
  const [targetId, setTargetId] = useState('')
  const [url, setUrl] = useState('')
  const [incoming, setIncoming] = useState('')
  const [outgoing, setOutgoing] = useState('')
  const [items, setItems] = useState<PairingInvitationMetadata[]>()
  const [attempts, setAttempts] = useState<PairingAttemptMetadata[]>()
  const [readFailed, setReadFailed] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [grants, setGrants] = useState<PairingGrants>({
    workspaces: [], workspaceManagement: false, sessionAccess: false, attachmentAccess: false,
    approvalAccess: false, terminalAccess: false, teamAccess: false, teamOperate: false,
  })
  useEffect(() => {
    let active = true
    void Promise.all([props.pairingList(), props.pairingAttempts()]).then(([value, pending]) => {
      if (active) { setItems(value); setAttempts(pending); setReadFailed(false) }
    }, () => { if (active) setReadFailed(true) })
    return () => { active = false }
  }, [generation, props.pairingList, props.pairingAttempts])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    try { await operation(); setGeneration(value => value + 1); props.notify('pairingChanged') }
    catch { props.notify('pairingFailed') }
    finally { setBusy(false) }
  }
  const create = () => {
    const id = z.uuid().safeParse(targetId)
    setInvalid(!id.success)
    if (!id.success) return
    void run(async () => {
      const invitation = await props.pairingCreate({ environmentId: brandString<PairingTarget['environmentId']>(id.data), url }, grants)
      setOutgoing(JSON.stringify(invitation))
    })
  }
  return <section className={css.pairing}>
    <h3>{t('pairingTitle')}</h3><p>{t('pairingHelp')}</p>
    <fieldset disabled={busy || !props.configuration.config.publicUrl} className={css.fields}>
      <label className={css.field}>{t('pairingTargetId')}<Input value={targetId} onChange={(event) => { setTargetId(event.target.value); setInvalid(false) }} /></label>
      <label className={css.field}>{t('pairingTargetUrl')}<Input value={url} onChange={(event) => { setUrl(event.target.value) }} /></label>
      {invalid && <p role="alert">{t('pairingInvalidId')}</p>}
      <h3>{t('pairingPermissions')}</h3><span>{t('pairingWorkspaces')}</span>
      {Object.keys(props.configuration.config.workspaces).length === 0 && <p>{t('pairingNoWorkspaces')}</p>}
      {Object.keys(props.configuration.config.workspaces).map(alias => <label key={alias}>
        <input type="checkbox" checked={grants.workspaces.includes(alias)} onChange={(event) => { setGrants({ ...grants, workspaces: event.target.checked ? [...grants.workspaces, alias] : grants.workspaces.filter(value => value !== alias) }) }} />{alias}
      </label>)}
      {permissions.map(([key, label]) => <label key={key}><input type="checkbox" checked={grants[key]} onChange={(event) => {
        const checked = event.target.checked
        setGrants({ ...grants, [key]: checked, ...(key === 'teamOperate' && checked ? { teamAccess: true } : {}), ...(key === 'teamAccess' && !checked ? { teamOperate: false } : {}) })
      }} />{t(label)}</label>)}
      <div><Button disabled={!targetId || !url} onClick={create}>{t('pairingCreate')}</Button></div>
      {outgoing && <><label className={css.field}>{t('pairingOutput')}<textarea className={css.transfer} readOnly value={outgoing} /></label><div><Button onClick={() => { setOutgoing('') }}>{t('pairingHide')}</Button></div></>}
      <label className={css.field}>{t('pairingInput')}<textarea className={css.transfer} value={incoming} onChange={(event) => { setIncoming(event.target.value) }} /></label>
      <p>{t('pairingRetryHelp')}</p>
      <div><Button disabled={!incoming} onClick={() => { void run(async () => { await props.pairingAccept(incoming, grants); setIncoming(''); props.changed() }) }}>{t('pairingAccept')}</Button></div>
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
      <code>{item.target.environmentId}</code><span>{item.target.url}</span><span>{t(statuses[item.status])}</span>
      {(item.status === 'pending' || item.status === 'redeeming') && <div><Button disabled={busy} onClick={() => { void run(async () => { await props.pairingRevoke(item.id) }) }}>{t('pairingRevoke')}</Button></div>}
    </div>)}
    <Button disabled={busy} onClick={() => { setGeneration(value => value + 1) }}>{t('pairingRefresh')}</Button>
  </section>
}
