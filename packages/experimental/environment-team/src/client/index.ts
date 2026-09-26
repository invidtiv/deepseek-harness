/** Browser registration for the environment team's Plugins configuration page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import remote from '@deepseek-ai/dsh-experimental-environment-team/remote'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Notice, type NoticeState } from './Notice.tsx'
import { Page, type PageActions } from './Page.tsx'
import { en, zh, type EnvironmentSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Environment team configuration copy. */
    environmentTeams: EnvironmentSettingsKey
  }
}

/** Services required to mount the experimental Remote contribution. */
export const inject = ['remote', 'slots', 'locale']

/** Register the configuration page beside the active experimental runtime.
 * @param ctx - browser plugin owner.
 * @returns disposer joining the page and its Remote contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const ui = ctx.inject(['remote.environmentTeamSettings', 'remote.credentials', 'slots', 'locale'], (child) => {
    child.effect(() => child.locale.register('environmentTeams', { en, zh }))
    const notice = createSnapshotStore<NoticeState>({ kind: null, sequence: 0 })
    child.slots.inject('shell.overlay', () => child.slots.register({ name: 'shell.overlay', id: 'environment-team-notice', locale: 'environmentTeams', inject: () => ({ hooks: { environmentNotice: notice }, dismiss: () => { notice.update((value) => { value.kind = null }) } }) }, Notice))
    const actions: PageActions = {
      notify: (kind) => { notice.update((value) => { value.kind = kind; value.sequence++ }) },
      read: async () => {
        const result = await child.remote.environmentTeamSettings.read()
        if (!result.ok) throw result.error
        return result.value
      },
      save: async (value) => {
        const result = await child.remote.environmentTeamSettings.save(value)
        if (!result.ok) throw result.error
        return result.value
      },
      credential: async (ref, value) => {
        const result = await child.remote.credentials.set(ref, value)
        if (!result.ok) throw result.error
      },
    }
    child.slots.inject('plugins.bundle.config', () => child.slots.register({
      name: 'plugins.bundle.config', key: '@deepseek-ai/dsh-experimental-environment-team',
      locale: 'environmentTeams', inject: () => actions,
    }, Page))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
