/** Real profile edits, credentials, storage and HTTP with a descriptor-only execution fixture. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { pairingDomain } from '../src/pairing-store.ts'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Config } from '../src/config.ts'
import { loadIdentity } from '../src/identity.ts'
import { DESCRIPTOR_PATH } from '../src/transport.ts'
import * as Pairing from '../src/pairing.ts'
import Settings from '../src/management.ts'

/** Start isolated invitation services over real profile and HTTP carriers.
 * @param own - immediately registers the acquired fixture cleanup.
 * @returns settings, context and filesystem roots owned by this fixture.
 */
export async function pairingHost(own: (close: () => Promise<void>) => void) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pairing-')))
  const owner: { ctx: Context | undefined } = { ctx: undefined }
  own(async () => { await owner.ctx?.fiber.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 5 }) })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"pairing-fixture"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const config = { stateDirectory: join(home, 'identity'), label: 'pairing host', provider: 'mock', model: 'mock', agentPreset: 'test', sandboxMode: 'read-only', approvalPolicy: 'ask', workspaces: { project: home }, peers: [] }
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'editor', name: 'cordis:editor' },
    { id: 'credentials', name: 'cordis:credentials', config: { path: join(home, 'credentials.yml'), watch: false } },
    { id: 'storage', name: 'cordis:storage' },
    { id: 'json', name: 'cordis:json', config: { root: join(home, 'storage') } },
    { id: 'domain', name: 'cordis:domain', config: { backend: 'json' } },
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'environment-team', name: 'cordis:environment', config },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
    root.provide('profileContext', profile)
    Object.assign(root.loader.builtins, {
      editor: ConfigEditor, credentials: Credentials, storage: Storage, json: JsonStorage, domain: StorageDomain, web: WebServer,
      environment: { name: 'environment-team', Config, inject: ['webServer'], async apply(scope: Context, values: Config) {
        const id = await loadIdentity(values.stateDirectory)
        scope.effect(() => scope.webServer.register({ kind: 'exact', path: DESCRIPTOR_PATH, handler(_request, response) {
          response.end(JSON.stringify({ environmentId: id, label: values.label, platform: 'test', protocol: 1, capabilities: { distributedTeams: true } }))
        } }))
      } },
    })
  })
  owner.ctx = ctx
  const controller = new Settings(ctx)
  const current = await controller.read()
  const url = `http://127.0.0.1:${ctx.webServer.port}`
  await controller.save({ ...current, config: { ...current.config, publicUrl: url } })
  const opened = vi.spyOn(ctx.storageDomain, 'open')
  const mounted = ctx.plugin(Pairing)
  await mounted
  const result = opened.mock.results.at(-1)
  if (result?.type !== 'return') throw new Error('Pairing domain did not open')
  const domain = await result.value as Domain<typeof pairingDomain>
  opened.mockRestore()
  return { ctx, controller, home, profile, url, mounted, domain }
}
