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
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { EnvironmentWorkspace } from '../workspace-types.ts'
import type { EnvironmentTerminalFollowRequest } from '../interaction-types.ts'
import { RemoteSessionController } from './session-controller.ts'
import { RemoteInteractionController } from './interaction-controller.ts'
import { encodeBrowserFile, downloadBrowserFile } from './browser-files.ts'
import { TeamController } from './team-controller.ts'
import { Teams, TeamsIcon, type TeamsFace } from './Teams.tsx'
import { Sessions, SessionsIcon, type SessionsFace } from './Sessions.tsx'
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
  const ui = ctx.inject(['remote.environmentTeamSettings', 'slots', 'locale', 'layout'], (child) => {
    child.effect(() => child.locale.register('environmentTeams', { en, zh }))
    const notice = createSnapshotStore<NoticeState>({ kind: null, sequence: 0 })
    const notify = (success: boolean) => { notice.update((value) => { value.kind = success ? 'sessionChanged' : 'sessionChangeFailed'; value.sequence++ }) }
    const interval = async () => {
      const result = await child.remote.environmentTeamSettings.read()
      if (!result.ok) throw result.error
      return result.value.config.sessionSyncIntervalMs
    }
    const interactions = new RemoteInteractionController(async (environment, request, signal) => {
      const result = await child.remote.environmentTeamSettings.sessionInteraction(environment, request, signal)
      if (!result.ok) throw result.error
      return result.value
    }, (environment, request, signal) => child.remote.environmentTeamSettings.terminalFollow(environment, request, signal),
    interval, notify)
    const teams = new TeamController(async (environment, request, signal) => {
      const result = await child.remote.environmentTeamSettings.teamDashboard(environment, request, signal)
      if (!result.ok) throw result.error
      return result.value
    }, async () => {
      const result = await child.remote.environmentTeamSettings.environments()
      if (!result.ok) throw result.error
      return result.value
    }, interval, (success) => { notice.update((value) => { value.kind = success ? 'teamInterrupted' : 'teamInterruptFailed'; value.sequence++ }) })
    child.effect(() => () => teams.dispose())
    const teamActions: TeamsFace = {
      hooks: { remoteTeams: teams.state }, resume: () => { teams.resume() }, pause: () => { teams.pause() },
      refresh: () => {  teams.refresh() }, selectEnvironment: (id) => { teams.selectEnvironment(id) },
      selectTeam: (id) => { teams.selectTeam(id) }, interrupt: (id) => { void teams.interrupt(id) },
    }
    child.slots.inject('main', () => child.slots.register({ name: 'main', key: 'environment-teams', locale: 'environmentTeams', inject: () => teamActions }, Teams))
    child.slots.inject('sidebar.panellist', () => child.slots.register({ name: 'sidebar.panellist', id: 'environment-teams', order: 2, label: () => child.locale.bind('environmentTeams')('teamDashboard'), locale: 'environmentTeams' }, TeamsIcon))
    const sessions = new RemoteSessionController(async (environment, request, signal) => {
      const result = await child.remote.environmentTeamSettings.session(environment, request, signal)
      if (!result.ok) throw result.error
      return result.value
    }, async () => {
      const result = await child.remote.environmentTeamSettings.read()
      if (!result.ok) throw result.error
      return result.value.config.sessionSyncIntervalMs
    }, (success) => { notice.update((value) => { value.kind = success ? 'sessionChanged' : 'sessionChangeFailed'; value.sequence++ }) },
    (environment, request, signal) => child.remote.environmentTeamSettings.sessionFollow(environment, request, signal))
    child.effect(() => () => sessions.dispose())
    child.effect(() => () => interactions.dispose())
    child.effect(() => sessions.state.subscribe(() => {
      const { workspace, sessionId } = sessions.state.getSnapshot()
      interactions.select(workspace && sessionId
        ? { environmentId: workspace.environmentId, workspaceId: workspace.workspaceId, sessionId } : undefined)
    }))
    child.on('connection/reset', () => { sessions.reconnect(); void interactions.refresh();  teams.refresh() })
    let releaseDownload: (() => void) | undefined
    child.effect(() => () => { releaseDownload?.() })
    const openWorkspace = (workspace: EnvironmentWorkspace) => {
      sessions.open(workspace); child.layout.selectPanel(brandString<MainPanelId>('environment-sessions'))
      void child.remote.environmentTeamSettings.read().then((result) => {
        if (!result.ok) return
        const url = workspace.environmentId === result.value.environmentId
          ? location.origin
          : result.value.config.peers.find(peer => peer.environmentId === workspace.environmentId)?.url
        if (url !== undefined) sessions.destination(workspace.environmentId, url)
      }).catch((_error: unknown) => { /* Endpoint metadata is retried with the next explicit workspace selection. */ })
    }
    const sessionActions: SessionsFace = {
      openWorkspace, earlier: () => { void sessions.earlier() }, backToLive: () => { sessions.backToLive() },
      hooks: { remoteSessions: sessions.state, remoteInteractions: interactions.state },
      resume: () => { sessions.resume(); interactions.resume() }, pause: () => { sessions.pause(); interactions.pause() },
      back: () => { child.layout.selectPanel(brandString<MainPanelId>('environments')) },
      refresh: () => { sessions.reconnect(); void interactions.refresh() }, create: () => { void sessions.create() },
      select: (id) => { sessions.select(id) }, draft: (text) => { sessions.draft(text) },
      send: () => { void sessions.send() }, cancel: () => { void sessions.cancel() },
      removeAttachment: (index) => { sessions.removeAttachment(index) },
      interaction: (request) => { void interactions.run(request) },
      terminalConnect: (id) => { interactions.connectTerminal(id) },
      terminalCreate: (cols, rows) => {
        const id = brandString<EnvironmentTerminalFollowRequest['terminalId']>(randomUUID())
        void interactions.run({ action: 'terminal-create', request: { id, cols, rows } }).then((result) => {
          if (result?.kind === 'terminal') interactions.connectTerminal(result.terminal.id)
        })
      },
      terminalWrite: (data) => { interactions.write(data) }, terminalRendered: (revision) => { interactions.rendered(revision) },
      upload: (file) => {
        const { snapshot, address } = interactions.state.getSnapshot()
        const selected = sessions.state.getSnapshot()
        if (!snapshot || !address || selected.busy || selected.uncertain) return
        if (file.size > snapshot.maxUploadBytes) { notice.update((value) => { value.kind = 'attachmentTooLarge'; value.sequence++ }); return }
        void encodeBrowserFile(file).then(async (data) => {
          const current = interactions.state.getSnapshot().address
          if (current?.environmentId !== address.environmentId || current.sessionId !== address.sessionId
            || current.workspaceId !== address.workspaceId) return
          const mediaType = file.type
          if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif') {
            sessions.stage(address, { name: file.name, image: { data, mediaType, name: file.name } }); notify(true)
          } else {
            const result = await interactions.run({ action: 'upload', data, name: file.name })
            if (result?.kind === 'uploaded') sessions.stage(address, { name: file.name, receipt: result.upload.receiptId })
          }
        }).catch((_error: unknown) => { notify(false) })
      },
      download: (attachment) => {
        void interactions.run({ action: 'download', attachmentId: attachment.attachmentId }).then((result) => {
          if (result?.kind !== 'download') return
          releaseDownload?.()
          releaseDownload = downloadBrowserFile(result.data, result.attachment.name, result.attachment.mediaType)
        }).catch((_error: unknown) => { notify(false) })
      },
    }
    child.slots.inject('main', () => child.slots.register({ name: 'main', key: 'environment-sessions', locale: 'environmentTeams', inject: () => sessionActions }, Sessions))
    child.slots.inject('sidebar.panellist', () => child.slots.register({ name: 'sidebar.panellist', id: 'environment-sessions', order: 3, label: () => child.locale.bind('environmentTeams')('remoteSessions'), locale: 'environmentTeams' }, SessionsIcon))
    child.slots.inject('shell.overlay', () => child.slots.register({ name: 'shell.overlay', id: 'environment-team-notice', locale: 'environmentTeams', inject: () => ({ hooks: { environmentNotice: notice }, dismiss: () => { notice.update((value) => { value.kind = null }) } }) }, Notice))
    const actions: PageActions = {
      notify: (kind) => { notice.update((value) => { value.kind = kind; value.sequence++ }) },
      read: async () => {
        const result = await child.remote.environmentTeamSettings.read()
        if (!result.ok) throw result.error
        return result.value
      },
      save: async (value, changes) => {
        const result = await child.remote.environmentTeamSettings.saveWithCredentials(value, changes)
        if (!result.ok) throw result.error
        return result.value
      },
      pairingCreate: async (grants) => {
        const result = await child.remote.environmentTeamSettings.pairingCreate(grants)
        if (!result.ok) throw result.error
        return result.value
      },
      pairingList: async () => {
        const result = await child.remote.environmentTeamSettings.pairingList()
        if (!result.ok) throw result.error
        return result.value
      },
      pairingRevoke: async (id) => {
        const result = await child.remote.environmentTeamSettings.pairingRevoke(id)
        if (!result.ok) throw result.error
      },
      pairingAccept: async (invitation, grants) => {
        const result = await child.remote.environmentTeamSettings.pairingImport(invitation, grants)
        if (!result.ok) throw result.error
        return result.value
      },
      pairingAttempts: async () => {
        const result = await child.remote.environmentTeamSettings.pairingAttempts()
        if (!result.ok) throw result.error
        return result.value
      },
      pairingForget: async (id) => {
        const result = await child.remote.environmentTeamSettings.pairingForget(id)
        if (!result.ok) throw result.error
      },
    }
    child.slots.inject('plugins.bundle.config', () => child.slots.register({
      name: 'plugins.bundle.config', key: '@deepseek-ai/dsh-experimental-environment-team',
      locale: 'environmentTeams', inject: () => actions,
    }, Page))
    const browser: EnvironmentsActions = {
      openSessions: openWorkspace,
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
