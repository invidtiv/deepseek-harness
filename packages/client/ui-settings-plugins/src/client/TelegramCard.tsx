/**
 * The Telegram bot's configuration page: which chats and users it routes to,
 * which workspaces it may open, and the pacing of its polling, queue, edits,
 * and approvals.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginConfigForm } from './PluginConfigForm.tsx'
import type { TelegramCardFace } from './telegram-card-controller.ts'

/** Props the renderer binds for the Telegram page. */
export type TelegramCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<TelegramCardFace>

/**
 * Render the Telegram bot's one-liner or its configuration form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function TelegramCard(props: TelegramCardProps) {
  const { t } = props
  const state = props.useTelegramCard(snapshot => snapshot)
  if (props.view === 'summary') return t('telegramDescription')
  const disabled = !state.writable
  return (
    <PluginConfigForm
      t={t}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-telegram-token-ref"
        label={t('telegramTokenRef')}
        hint={t('telegramTokenRefHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidList')}
        disabled={disabled}
        {...state.tokenRef}
        onEdit={(text) => { props.edit('tokenRef', text) }}
        onReset={() => { props.resetField('tokenRef') }}
      />
      <ValueField
        id="plugin-config-telegram-api-base"
        label={t('telegramApiBase')}
        hint={t('telegramApiBaseHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidList')}
        disabled={disabled}
        {...state.apiBase}
        onEdit={(text) => { props.edit('apiBase', text) }}
        onReset={() => { props.resetField('apiBase') }}
      />
      <ValueField
        id="plugin-config-telegram-default-workspace"
        label={t('telegramDefaultWorkspace')}
        hint={t('telegramDefaultWorkspaceHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidList')}
        disabled={disabled}
        {...state.defaultWorkspace}
        onEdit={(text) => { props.edit('defaultWorkspace', text) }}
        onReset={() => { props.resetField('defaultWorkspace') }}
      />
      <ValueField
        id="plugin-config-telegram-poll-timeout"
        label={t('telegramPollTimeoutMs')}
        hint={t('telegramPollTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.pollTimeoutMs}
        onEdit={(text) => { props.edit('pollTimeoutMs', text) }}
        onReset={() => { props.resetField('pollTimeoutMs') }}
      />
      <ValueField
        id="plugin-config-telegram-queue-cap"
        label={t('telegramQueueCap')}
        hint={t('telegramQueueCapHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.queueCap}
        onEdit={(text) => { props.edit('queueCap', text) }}
        onReset={() => { props.resetField('queueCap') }}
      />
      <ValueField
        id="plugin-config-telegram-edit-interval"
        label={t('telegramEditIntervalMs')}
        hint={t('telegramEditIntervalMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.editIntervalMs}
        onEdit={(text) => { props.edit('editIntervalMs', text) }}
        onReset={() => { props.resetField('editIntervalMs') }}
      />
      <ValueField
        id="plugin-config-telegram-approval-timeout"
        label={t('telegramApprovalTimeoutMs')}
        hint={t('telegramApprovalTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.approvalTimeoutMs}
        onEdit={(text) => { props.edit('approvalTimeoutMs', text) }}
        onReset={() => { props.resetField('approvalTimeoutMs') }}
      />
      <ValueField
        id="plugin-config-telegram-allowed-chat-ids"
        label={t('telegramAllowedChatIds')}
        hint={t('telegramAllowedChatIdsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidList')}
        disabled={disabled}
        {...state.allowedChatIds}
        onEdit={(text) => { props.edit('allowedChatIds', text) }}
        onReset={() => { props.resetField('allowedChatIds') }}
      />
      <ValueField
        id="plugin-config-telegram-allowed-user-ids"
        label={t('telegramAllowedUserIds')}
        hint={t('telegramAllowedUserIdsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidList')}
        disabled={disabled}
        {...state.allowedUserIds}
        onEdit={(text) => { props.edit('allowedUserIds', text) }}
        onReset={() => { props.resetField('allowedUserIds') }}
      />
      <ValueField
        id="plugin-config-telegram-workspace-roots"
        label={t('telegramWorkspaceRoots')}
        hint={t('telegramWorkspaceRootsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidList')}
        disabled={disabled}
        {...state.workspaceRoots}
        onEdit={(text) => { props.edit('workspaceRoots', text) }}
        onReset={() => { props.resetField('workspaceRoots') }}
      />
    </PluginConfigForm>
  )
}
