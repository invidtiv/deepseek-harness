/**
 * Opt-in acceptance over two real SSH worlds: one router, two connections, and
 * every filesystem call served by the connection that owns its target's world.
 *
 * Set `DSH_SSH_TEST_CONFIG` and `DSH_SSH_TEST_SECOND_CONFIG` to two
 * `SshConnection` config files whose `workspace` values are distinct absolute
 * directories on their hosts. On Windows the suite self-skips.
 */

import { readFileSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SshConnection, type Config } from '../../ssh/src/index.ts'
import { SshWorlds } from '../../ssh/src/worlds.ts'
import { SshFileSystem } from '../src/index.ts'

const firstPath = process.env.DSH_SSH_TEST_CONFIG
const secondPath = process.env.DSH_SSH_TEST_SECOND_CONFIG
const enabled = process.platform !== 'win32' && firstPath !== undefined && secondPath !== undefined

/** Read one connection config the deployment would install on its remote host. */
function connectionConfig(path: string): Config {
  return JSON.parse(readFileSync(path, 'utf8')) as Config
}

async function setup() {
  const first = connectionConfig(firstPath as string)
  const second = connectionConfig(secondPath as string)
  const firstRoot = first.workspace
  const secondRoot = second.workspace
  const ctx = new Context()
  // The registry only supplies the shared OpenSSH destination; routing is what
  // this suite exercises.
  ctx.provide('sshEnvironments', { resolve: () => ({ host: 'localhost' }) } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [
      { transport: 'ssh', environmentId: 'world-a', path: firstRoot },
      { transport: 'ssh', environmentId: 'world-b', path: secondRoot },
    ],
  } as never)
  // The deployment policy the providers resolve when a call carries none; this
  // suite exercises routing, so it stands in for the shipped policy service.
  class Policy extends Service {
    readonly defaultMode = 'workspace-write'
    constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
    resolve(): { mode: 'workspace-write'; workspaceRoot: string } {
      return { mode: 'workspace-write', workspaceRoot: firstRoot }
    }
  }
  const fibers = [
    await ctx.plugin(Policy),
    await ctx.plugin(SshWorlds, { defaultEnvironment: 'world-a' }),
    await ctx.plugin(SshConnection, { ...first, environment: 'world-a' }),
    // The second world keeps its own service identity, exactly as the shipped
    // profile isolates its row.
    await ctx.isolate('ssh').plugin(SshConnection, { ...second, environment: 'world-b' }),
    await ctx.plugin(SshFileSystem),
  ]
  onTestFinished(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  return { ctx, worlds: ctx.sshWorlds, firstRoot, secondRoot }
}

describe.skipIf(!enabled)('two SSH worlds behind one router', () => {
  it('routes each file operation to the connection that owns its directory', async () => {
    const { ctx, worlds, firstRoot, secondRoot } = await setup()
    const policy = (workspaceRoot: string) => ({ mode: 'workspace-write' as const, workspaceRoot })

    // The same file name in both worlds: a misrouted read would return the
    // other world's content.
    const firstTarget = await ctx.fs.resolve(`${firstRoot}/probe.txt`)
    const secondTarget = await ctx.fs.resolve(`${secondRoot}/probe.txt`)
    await ctx.fs.writeText(firstTarget, 'first world', undefined, undefined, policy(firstRoot))
    await ctx.fs.writeText(secondTarget, 'second world', undefined, undefined, policy(secondRoot))

    expect(await ctx.fs.readText(firstTarget)).toBe('first world')
    expect(await ctx.fs.readText(secondTarget)).toBe('second world')
    expect(worlds.worldFor(firstTarget.targetKey as string)).toBe('world-a')
    expect(worlds.worldFor(secondTarget.targetKey as string)).toBe('world-b')
    expect(worlds.worldFor('/srv/unclaimed')).toBeUndefined()
  })

  it('serves an unclaimed target from the configured default world', async () => {
    const { ctx, firstRoot } = await setup()

    // No locator claims the default workspace root before a workspace is
    // registered for it, so the pool falls back to its configured default.
    const target = await ctx.fs.resolve(`${firstRoot}/default.txt`)
    await ctx.fs.writeText(target, 'default world', undefined, undefined, {
      mode: 'workspace-write', workspaceRoot: firstRoot,
    })

    expect(await ctx.fs.readText(target)).toBe('default world')
  })
})
