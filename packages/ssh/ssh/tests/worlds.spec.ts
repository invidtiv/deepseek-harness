/** Pool registration and target routing across several SSH environments. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  SshWorldAmbiguousError, SshWorldMultipleError, SshWorldUnavailableError, SshWorlds, type SshWorldConnection,
} from '../src/worlds.ts'

/** A connection stand-in that records the operations routed to it. */
interface Wire extends SshWorldConnection {
  readonly id: string
  readonly calls: string[]
}

function connection(id: string): Wire {
  const calls: string[] = []
  return {
    id,
    calls,
    request<T>(method: string): Promise<T> {
      calls.push(method)
      return Promise.resolve(undefined as T)
    },
    connectStream: () => Promise.reject(new Error('the pool routes no stream in these tests')),
    dispose: () => Promise.resolve(),
  }
}

/** One workspace row the pool reads as a locator. */
interface LocatorRow {
  readonly transport: 'local' | 'ssh'
  readonly environmentId?: string
  readonly path: string
}

/** Boot a pool over optional registrations and workspace locators. */
function harness(options: {
  register?: readonly (readonly [string | undefined, Wire])[]
  workspaces?: readonly LocatorRow[]
  defaultEnvironment?: string
} = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  if (options.workspaces !== undefined) {
    ctx.provide('workspaceRegistry', { list: () => options.workspaces } as never)
  }
  const pool = new SshWorlds(
    ctx,
    options.defaultEnvironment === undefined ? {} : { defaultEnvironment: options.defaultEnvironment },
  )
  for (const [environmentId, wire] of options.register ?? []) pool.register(environmentId, wire)
  return pool
}

describe('SshWorlds', () => {
  it('lists named worlds and sends an unclaimed target to the default connection', () => {
    const fallback = connection('default')
    const pool = harness({ register: [[undefined, fallback], ['build01', connection('build01')]] })

    expect(pool.list()).toEqual(['build01'])
    expect(pool.worldFor('/srv/app')).toBeUndefined()
    expect(pool.connectionFor('/srv/app')).toBe(fallback)
  })

  it('resolves a named world explicitly, without a locator claim', () => {
    const build01 = connection('build01')
    const pool = harness({ register: [[undefined, connection('default')], ['build01', build01]] })

    expect(pool.connectionForEnvironment('build01')).toBe(build01)
    expect(() => pool.connectionForEnvironment('missing')).toThrow(SshWorldUnavailableError)
  })

  it('refuses a second connection for one world, default included', () => {
    const pool = harness({ register: [['build01', connection('first')], [undefined, connection('default')]] })

    expect(() => pool.register('build01', connection('second'))).toThrow(/already has a composed connection/)
    expect(() => pool.register(undefined, connection('fallback'))).toThrow(/already has a composed connection/)
  })

  it('routes an SSH workspace without a named environment to the default connection', () => {
    const fallback = connection('default')
    const pool = harness({
      register: [[undefined, fallback]],
      workspaces: [{ transport: 'ssh', path: '/srv/home' }],
    })

    expect(pool.worldFor('/srv/home/file.ts')).toBeUndefined()
    expect(pool.connectionFor('/srv/home/file.ts')).toBe(fallback)
  })

  it('refuses a default locator that claims a named world\u2019s directory', () => {
    const pool = harness({
      register: [['build01', connection('a')], [undefined, connection('default')]],
      workspaces: [
        { transport: 'ssh', environmentId: 'build01', path: '/srv/app' },
        { transport: 'ssh', path: '/srv/app' },
      ],
    })

    expect(() => pool.worldFor('/srv/app/x')).toThrow(SshWorldAmbiguousError)

    // The registry order decides which claim is reported first; both are refused.
    const reversed = harness({
      register: [['build01', connection('a')], [undefined, connection('default')]],
      workspaces: [
        { transport: 'ssh', path: '/srv/app' },
        { transport: 'ssh', environmentId: 'build01', path: '/srv/app' },
      ],
    })
    expect(() => reversed.connectionFor('/srv/app/x')).toThrow(SshWorldAmbiguousError)
  })

  it('routes a target to the longest owning locator and ignores local workspaces', () => {
    const build01 = connection('build01')
    const build02 = connection('build02')
    const pool = harness({
      register: [['build01', build01], ['build02', build02]],
      workspaces: [
        { transport: 'local', path: '/srv/app' },
        { transport: 'ssh', environmentId: 'build01', path: '/srv/app' },
        { transport: 'ssh', environmentId: 'build01', path: '/srv/app' },
        { transport: 'ssh', environmentId: 'build02', path: '/srv/app/nested' },
      ],
    })

    expect(pool.connectionFor('/srv/app')).toBe(build01)
    expect(pool.connectionFor('/srv/app/file.ts')).toBe(build01)
    // A nested workspace owns its own subtree even though its parent matches too.
    expect(pool.connectionFor('/srv/app/nested/deep/file.ts')).toBe(build02)
  })

  it('serves an unclaimed target from the configured default world', () => {
    const build01 = connection('build01')
    const pool = harness({ register: [['build01', build01]], defaultEnvironment: 'build01' })

    expect(pool.connectionFor('/srv/anything')).toBe(build01)
  })

  it('fails visibly when no world claims a target and no default is composed', () => {
    const pool = harness({ register: [['build01', connection('build01')]] })

    expect(() => pool.connectionFor('/etc')).toThrow(SshWorldUnavailableError)
    expect(() => pool.connectionFor('/etc')).toThrow(/no default world connection/)
  })

  it('fails visibly when a locator names a world with no composed connection', () => {
    const fallback = connection('default')
    const pool = harness({
      register: [[undefined, fallback]],
      workspaces: [{ transport: 'ssh', environmentId: 'build09', path: '/srv/app' }],
    })

    expect(() => pool.connectionFor('/srv/app/file.ts')).toThrow(SshWorldUnavailableError)
    expect(pool.connectionFor('/elsewhere')).toBe(fallback)
  })

  it('refuses two worlds that claim one directory', () => {
    const pool = harness({
      register: [['build01', connection('a')], ['build02', connection('b')]],
      workspaces: [
        { transport: 'ssh', environmentId: 'build01', path: '/srv/app' },
        { transport: 'ssh', environmentId: 'build02', path: '/srv/app' },
      ],
    })

    const failure: unknown = (() => {
      try { pool.worldFor('/srv/app/x'); return undefined } catch (error: unknown) { return error }
    })()
    expect(failure).toBeInstanceOf(SshWorldAmbiguousError)
    expect(failure).toMatchObject({ path: '/srv/app', environmentIds: ['build01', 'build02'] })
  })

  it('normalizes a trailing separator and routes a root locator', () => {
    const rooted = connection('rooted')
    const pool = harness({
      register: [['rooted', rooted]],
      workspaces: [
        { transport: 'ssh', environmentId: 'rooted', path: '/' },
        { transport: 'ssh', environmentId: 'rooted', path: '/srv/app/' },
      ],
    })

    expect(pool.connectionFor('/srv/app')).toBe(rooted)
    expect(pool.connectionFor('/srv/app/file.ts')).toBe(rooted)
    expect(pool.connectionFor('/opt/other')).toBe(rooted)
  })

  it('refuses a targetless operation while named worlds are composed', () => {
    const pool = harness({ register: [['build01', connection('build01')], [undefined, connection('default')]] })

    expect(() => { pool.requireDefaultWorld('executable resolution') }).toThrow(SshWorldMultipleError)
    expect(() => { pool.requireDefaultWorld('executable resolution') }).toThrow(/needs one world.*build01/)
  })

  it('allows a targetless operation for a single-world deployment', () => {
    const pool = harness({ register: [[undefined, connection('default')]] })

    expect(() => { pool.requireDefaultWorld('executable resolution') }).not.toThrow()
  })

  it('drops a world when its registration is disposed', () => {
    const pool = harness({ register: [['build01', connection('build01')]] })
    const dispose = pool.register('build02', connection('build02'))
    expect(pool.list()).toEqual(['build01', 'build02'])

    dispose()
    expect(pool.list()).toEqual(['build01'])
  })
})
