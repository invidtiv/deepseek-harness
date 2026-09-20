/**
 * Local execution world for a mixed deployment. The SSH providers serve a
 * target an SSH world owns and fall back to `localFs`, `localSubprocess` and
 * `localSandbox` for a target no world claims; this entry composes those three
 * providers in their own service realms and publishes them under those names.
 *
 * That leaves the execution seams themselves to the SSH providers, so one
 * process serves local and remote workspaces together. A deployment that
 * serves only one world composes the local providers directly instead.
 * @module @deepseek-ai/dsh-ssh/local-world
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

/** Cordis plugin name. */
export const name = 'ssh-local-world'

/** Required service: the shared file-effect policy each local provider resolves. */
export const inject = ['sandboxPolicy']

/**
 * One local provider: the execution-seam service it registers, the global name
 * its instance is published under, and the plugin that composes it.
 */
interface LocalProvider {
  /** Execution-seam service the provider registers in its own realm. */
  readonly service: 'fs' | 'subprocess' | 'sandbox'
  /** Global service name the SSH providers read as their local fallback. */
  readonly published: string
  /** Provider plugin, composed once in a fresh realm. */
  readonly plugin: Plugin
}

const PROVIDERS: readonly LocalProvider[] = [
  { service: 'fs', published: 'localFs', plugin: SandboxedFileSystem },
  { service: 'subprocess', published: 'localSubprocess', plugin: LocalSubprocessRuntime },
  { service: 'sandbox', published: 'localSandbox', plugin: LocalSandboxProvider },
]

/**
 * Compose the local execution providers in their own realms and publish them
 * under the names the SSH providers fall back to. Every registration is an
 * effect of this plugin's fiber — the child realms included — so unloading the
 * entry removes each published service and joins every realm's teardown.
 * @param ctx - Host context the realms extend.
 */
export async function apply(ctx: Context): Promise<void> {
  for (const { service, published, plugin } of PROVIDERS) {
    // Each provider keeps its own service identity, so the local world
    // registers the seam exactly once per process.
    const realm = ctx.isolate(service, Symbol.for(`dsh-local-world:${service}`))
    await realm.plugin(plugin)
    ctx.provide(published, realm.get(service, false) as never)
  }
}
