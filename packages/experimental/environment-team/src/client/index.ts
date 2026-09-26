/** Browser registration for the environment team's Plugins configuration page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import remote from '@deepseek-ai/dsh-experimental-environment-team/remote'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteSessionController } from './session-controller.ts'
import { Sessions, type SessionsFace } from './Sessions.tsx'
import { Notice, type NoticeState } from './Notice.tsx'
import { Page, type PageActions } from './Page.tsx'
import { en, zh, type EnvironmentSettingsKey } from './locales.ts'
import { Environments, EnvironmentsIcon, type EnvironmentsActions } from './Environments.tsx'

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
  const ui = ctx.inject(['remote.environmentTeamSettings', 'remote.credentials', 'slots', 'locale', 'layout'], (child) => {
    child.effect(() => child.locale.register('environmentTeams', { en, zh }))
    const notice = createSnapshotStore<NoticeState>({ kind: null, sequence: 0 })
    const sessions = new RemoteSessionController(async (environment, request, signal) => {
      const result = await child.remote.environmentTeamSettings.session(environment, request, signal)
      if (!result.ok) throw result.error
      return result.value
    }, async () => {
      const result = await child.remote.environmentTeamSettings.read()
      if (!result.ok) throw result.error
      return result.value.config.sessionSyncIntervalMs
    }, (success) => { notice.update((value) => { value.kind = success ? 'sessionChanged' : 'sessionChangeFailed'; value.sequence++ }) })
    child.effect(() => () => { sessions.pause() })
    child.on('connection/reset', () => { void sessions.refresh() })
    const sessionActions: SessionsFace = {
      hooks: { remoteSessions: sessions.state }, resume: () => { sessions.resume() }, pause: () => { sessions.pause() },
      back: () => { child.layout.selectPanel(brandString<MainPanelId>('environments')) },
      refresh: () => { void sessions.refresh() }, create: () => { void sessions.create() },
      select: (id) => { sessions.select(id) }, draft: (text) => { sessions.draft(text) },
      send: () => { void sessions.send() }, cancel: () => { void sessions.cancel() },
    }
    child.slots.inject('main', () => child.slots.register({ name: 'main', key: 'environment-sessions', locale: 'environmentTeams', inject: () => sessionActions }, Sessions))
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
    const browser: EnvironmentsActions = {
      openSessions: (workspace) => {
        sessions.open(workspace); child.layout.selectPanel(brandString<MainPanelId>('environment-sessions'))
        void child.remote.environmentTeamSettings.read().then((result) => {
          if (!result.ok) return
          const url = workspace.environmentId === result.value.environmentId
            ? location.origin
            : result.value.config.peers.find(peer => peer.environmentId === workspace.environmentId)?.url
          if (url !== undefined) sessions.destination(workspace.environmentId, url)
        }).catch((_error: unknown) => { /* Endpoint metadata is retried with the next explicit workspace selection. */ })
      },
      environments: async () => {
        const result = await child.remote.environmentTeamSettings.environments()
        if (!result.ok) throw result.error
        return result.value
      },
      workspace: async (environment, request) => {
        const result = await child.remote.environmentTeamSettings.workspace(environment, request)
        if (!result.ok) throw result.error
        return result.value
      },
      notify: (kind) => { notice.update((value) => { value.kind = kind; value.sequence++ }) },
    }
    child.slots.inject('main', () => child.slots.register({ name: 'main', key: 'environments', locale: 'environmentTeams', inject: () => browser }, Environments))
    child.slots.inject('sidebar.panellist', () => child.slots.register({ name: 'sidebar.panellist', id: 'environments', order: 1, label: () => child.locale.bind('environmentTeams')('environments'), locale: 'environmentTeams' }, EnvironmentsIcon))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
