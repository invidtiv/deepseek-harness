import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it } from 'vitest'
import SshEnvironments, {
  SSH_ENVIRONMENTS_NAMESPACE,
  SshEnvironmentUnknownError,
  type SshEnvironmentId,
} from '../src/index.ts'

/** In-memory settings provider: the registry's only external dependency. */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  private readonly sections = new Map<string, Record<string, unknown>>()

  protected async load(): Promise<Record<string, unknown>> { return {} }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.sections.set(ns, section)
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!() })

/** Boot the registry beside a settings provider and seed one environment. */
async function boot(withSettings: boolean): Promise<Context> {
  const ctx = new Context()
  if (withSettings) {
    const settings = ctx.plugin(MemorySettings)
    cleanup.push(async () => { await settings.dispose() })
    await settings
  }
  const registry = ctx.plugin(SshEnvironments)
  cleanup.push(async () => { await registry.dispose() })
  await registry
  return ctx
}

const namespace = SSH_ENVIRONMENTS_NAMESPACE as SettingsNamespace

describe('SshEnvironments', () => {
  it('lists environments with a label defaulting to the id', async () => {
    const ctx = await boot(true)
    await ctx.settings.replace(namespace, {
      environments: {
        build01: { host: 'build01.example', label: 'Build 01', port: 2222 },
        dev: { host: 'dev.example' },
      },
    })
    expect(ctx.sshEnvironments.list()).toEqual([
      { id: 'build01', label: 'Build 01', host: 'build01.example', port: 2222 },
      { id: 'dev', label: 'dev', host: 'dev.example' },
    ])
  })

  it('projects picker-safe fields only, never a connection reference or credential', async () => {
    const ctx = await boot(true)
    await ctx.settings.replace(namespace, {
      environments: {
        build01: {
          host: 'build01.example', label: 'Build 01', port: 2222, user: 'alice',
          identityFile: '~/.ssh/id_ed25519', identityAgent: '/run/ssh-agent.sock',
          proxyJump: 'bastion', configFile: '/etc/ssh/ssh_config',
        },
      },
    })

    const projection = ctx.sshEnvironments.list()
    expect(projection).toEqual([
      { id: 'build01', label: 'Build 01', host: 'build01.example', port: 2222 },
    ])
    // The client-facing projection carries no login name, key path, agent socket,
    // jump destination, or config path; only the destination is picker vocabulary.
    const serialized = JSON.stringify(projection)
    for (const reference of ['alice', 'id_ed25519', 'ssh-agent', 'bastion', 'ssh_config']) {
      expect(serialized).not.toContain(reference)
    }
  })

  it('registers a namespace a configuration surface can render', async () => {
    const ctx = await boot(true)
    await ctx.settings.replace(namespace, {
      environments: { build01: { host: 'build01.example', user: 'alice' } },
    })

    const descriptor = ctx.settings.describe({ redactSecrets: true })
      .find(entry => entry.ns === SSH_ENVIRONMENTS_NAMESPACE)
    expect(descriptor).toBeDefined()
    // The serialized schema is what the configuration page builds its form from,
    // and the stored connection fields are what the operator configured.
    expect(descriptor?.schema).toBeDefined()
    expect(descriptor?.value).toEqual({ environments: { build01: { host: 'build01.example', user: 'alice' } } })
    // The registry declares no secret slot, so nothing here needs wire redaction.
    expect(descriptor?.secrets).toEqual([])
  })

  it('resolves an entry into normalized OpenSSH options without its label', async () => {
    const ctx = await boot(true)
    await ctx.settings.replace(namespace, {
      environments: {
        build01: { host: 'build01.example', label: 'Build 01', port: 2222, user: 'alice', proxyJump: 'bastion' },
      },
    })
    expect(ctx.sshEnvironments.resolve('build01' as SshEnvironmentId)).toEqual({
      host: 'build01.example',
      port: 2222,
      user: 'alice',
      proxyJump: 'bastion',
      hostKeyChecking: 'yes',
      serverAliveIntervalMs: 10_000,
      serverAliveCountMax: 3,
    })
  })

  it('reports an unknown id instead of guessing an environment', async () => {
    const ctx = await boot(true)
    expect(ctx.sshEnvironments.get('missing' as SshEnvironmentId)).toBeUndefined()
    expect(() => ctx.sshEnvironments.resolve('missing' as SshEnvironmentId)).toThrow(SshEnvironmentUnknownError)
  })

  it('rejects a write the connection schema cannot admit', async () => {
    const ctx = await boot(true)
    await expect(ctx.settings.replace(namespace, {
      environments: { build01: { host: 'build01.example', port: 70_000 } },
    })).rejects.toThrow()
  })

  it('fails loud when no settings provider is composed', async () => {
    const ctx = await boot(false)
    expect(() => ctx.sshEnvironments.list()).toThrow('requires a composed settings provider')
  })
})
