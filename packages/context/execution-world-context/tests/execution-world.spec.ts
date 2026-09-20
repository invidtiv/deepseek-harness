/** Execution-world awareness: a remote workspace is named, a local one stays silent. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished } from 'vitest'
import { apply, name } from '../src/index.ts'

interface World {
  path: string
  transport: string
  environmentId?: string
}

/** Boot the prompt registry and this context over controllable world sources. */
async function harness(
  workspaces: readonly World[] | undefined,
  environments: readonly { id: string; label: string }[] | undefined,
) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  if (workspaces !== undefined) ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  if (environments !== undefined) ctx.provide('sshEnvironments', { list: () => environments } as never)
  const fiber = await ctx.plugin({ name, inject: ['systemPrompt'], apply })
  onTestFinished(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  return ctx
}

/** The execution-world context text for one assembly; empty when none applies. */
async function line(ctx: Context, cwd: string): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ agent: { session: { header: { cwd } } } } as never)
  return assembly.contexts.find(context => context.name === 'execution-world')?.text ?? ''
}

describe('execution-world context', () => {
  it('names the SSH environment a remote workspace lives in', async () => {
    const ctx = await harness(
      [{ path: '/home/bsdev/BS/oculon', transport: 'ssh', environmentId: 'bsdev' }],
      [{ id: 'bsdev', label: 'BSD dev' }],
    )

    expect(await line(ctx, '/home/bsdev/BS/oculon')).toBe(
      'Your workspace /home/bsdev/BS/oculon lives in SSH environment "BSD dev" (bsdev). '
      + 'Files, processes and sandboxing execute on that remote host, not on the machine serving this interface.',
    )
  })

  it('names an unnamed remote host without an environment id', async () => {
    const ctx = await harness([{ path: '/srv/project', transport: 'ssh' }], [])

    expect(await line(ctx, '/srv/project')).toContain('lives in a remote SSH host.')
  })

  it('stays silent for a local workspace, an unowned cwd, and absent sources', async () => {
    const local = await harness([{ path: '/home/alice/project', transport: 'local' }], [])
    expect(await line(local, '/home/alice/project')).toBe('')

    const unowned = await harness([{ path: '/other', transport: 'ssh', environmentId: 'build01' }], [])
    expect(await line(unowned, '/not/registered')).toBe('')

    const bare = await harness(undefined, undefined)
    expect(await line(bare, '/home/bsdev/BS/oculon')).toBe('')
  })
})
