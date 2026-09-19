/** The SSH environments page: the named POSIX servers this deployment can reach. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginConfigForm } from './PluginConfigForm.tsx'
import type { SshEnvironmentRow, SshEnvironmentsCardFace } from './ssh-environments-card-controller.ts'
import css from './SshEnvironmentsCard.module.css'

/** Props the renderer binds for the SSH environments page. */
export type SshEnvironmentsCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SshEnvironmentsCardFace>

/**
 * Render the SSH environments page or its one-liner, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the row snapshot, and its actions.
 * @returns the one-liner, or the row editor.
 */
export function SshEnvironmentsCard(props: SshEnvironmentsCardProps) {
  const { t } = props
  const state = props.useSshEnvironmentsCard(snapshot => snapshot)
  if (props.view === 'summary') return t('sshEnvironmentsDescription')
  const disabled = !state.writable
  return (
    <PluginConfigForm t={t} state={state} onSave={props.save} onDiscard={props.discard}>
      {state.rows.length === 0 ? <p className={css.empty} role="status">{t('sshEnvironmentsEmpty')}</p> : null}
      <div className={css.rows}>
        {state.rows.map(row => (
          <EnvironmentRow
            key={row.key}
            row={row}
            t={t}
            disabled={disabled}
            onEditId={(text) => { props.editId(row.key, text) }}
            onEditHost={(text) => { props.editHost(row.key, text) }}
            onRemove={() => { props.remove(row.key) }}
          />
        ))}
      </div>
      <button type="button" className={css.add} disabled={disabled} onClick={props.add}>
        {t('sshEnvironmentsAdd')}
      </button>
    </PluginConfigForm>
  )
}

/** One environment row: its identifier, its OpenSSH destination, and its removal. */
function EnvironmentRow({ row, t, disabled, onEditId, onEditHost, onRemove }: {
  row: SshEnvironmentRow
  t: SshEnvironmentsCardProps['t']
  disabled: boolean
  onEditId: (text: string) => void
  onEditHost: (text: string) => void
  onRemove: () => void
}) {
  const id = `plugin-config-ssh-id-${row.key}`
  const host = `plugin-config-ssh-host-${row.key}`
  // The invalid message sits outside the label: a message inside would join the
  // control's accessible name.
  return (
    <div className={css.row}>
      <div className={css.field}>
        <label className={css.label} htmlFor={id}>{t('sshEnvironmentId')}</label>
        <input
          id={id}
          className={css.input}
          value={row.id}
          disabled={disabled}
          aria-invalid={row.idInvalid}
          placeholder={t('sshEnvironmentIdPlaceholder')}
          onChange={(event) => { onEditId(event.target.value) }}
        />
        {row.idInvalid ? <p className={css.invalid} role="status">{t('sshEnvironmentRowInvalid')}</p> : null}
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor={host}>{t('sshEnvironmentHost')}</label>
        <input
          id={host}
          className={css.input}
          value={row.host}
          disabled={disabled}
          aria-invalid={row.hostInvalid}
          placeholder={t('sshEnvironmentHostPlaceholder')}
          onChange={(event) => { onEditHost(event.target.value) }}
        />
        {row.hostInvalid ? <p className={css.invalid} role="status">{t('sshEnvironmentRowInvalid')}</p> : null}
      </div>
      <button type="button" className={css.remove} disabled={disabled} onClick={onRemove}>
        {t('sshEnvironmentRemove')}
      </button>
    </div>
  )
}
