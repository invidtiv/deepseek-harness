/**
 * The Web Workspace flow over one non-host execution world: the controller
 * creates an SSH-transport Workspace at a remote path and then reads that same
 * world back, so the locator a client records and the directory it explores
 * come from one filesystem provider.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceController from '../src/index.ts'

type Dispatch = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>

/** Remote world: one project directory holding one text file. */
const REMOTE_ROOT = '/srv/project'

/**
 * Boot the controller over an SSH-transport workspace registry whose
 * filesystem is a stub wire, so every path resolves in the remote world.
 * @param options - named environment the stubbed SSH connection resolved.
 * @returns the controller, its context, and the wire's recorded calls.
 */
async function harness(options: { environmentId?: string } = {}) {
  const dispatch = vi.fn<Dispatch>()
  class WireConnection extends Service {
    readonly environmentId: string | undefined
    constructor(ctx: Context) {
      super(ctx, 'ssh')
      this.environmentId = options.environmentId
    }
    async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return result.parse(await dispatch(method, params, signal))
    }
  }
  dispatch.mockImplementation(async (method) => {
    if (method === 'fs.resolve') return { targetKey: REMOTE_ROOT, displayPath: REMOTE_ROOT }
    if (method === 'fs.stat') return { version: 'v1', type: 'directory' }
    if (method === 'fs.list') {
      return [{ name: 'app', type: 'directory', target: { targetKey: `${REMOTE_ROOT}/app`, displayPath: `${REMOTE_ROOT}/app` } }]
    }
    throw new Error(`unexpected method ${method}`)
  })
  /** The SSH filesystem's only host-plane dependency: one resolved policy. */
  class Policy extends Service {
    readonly defaultMode = 'read-only'
    constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
    resolve(): SandboxExecutionPolicy { return { mode: 'read-only', workspaceRoot: REMOTE_ROOT } }
  }

  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-remote-workspace-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(tempDir, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WireConnection)
  await ctx.plugin(Policy)
  await ctx.plugin(SshFileSystem)
  await ctx.plugin(WorkspaceRegistry)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
  return { controller: new WorkspaceController(ctx), ctx, dispatch }
}

describe('WorkspaceController over a remote execution world', () => {
  it('records an SSH locator and lists that world through the same provider', async () => {
    const { controller, dispatch } = await harness({ environmentId: 'build01' })

    const created = await controller.create({
      path: REMOTE_ROOT, transport: 'ssh', environmentId: 'build01',
    })
    expect(created).toMatchObject({
      created: true,
      workspace: { transport: 'ssh', environmentId: 'build01', path: REMOTE_ROOT },
    })

    const listing = await controller.listFiles({ path: REMOTE_ROOT }, new AbortController().signal)
    expect(listing).toMatchObject({
      path: REMOTE_ROOT,
      truncated: false,
      entries: [{ name: 'app', path: `${REMOTE_ROOT}/app`, kind: 'directory', hidden: false }],
    })
    // Every path the controller touched stayed in the remote world.
    const paths = dispatch.mock.calls
      .map(([, params]) => (params as { path?: string }).path)
      .filter((path): path is string => path !== undefined)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every(path => path.startsWith('/'))).toBe(true)
  })

  it('adopts the composed SSH world when the request omits the transport', async () => {
    const { controller } = await harness({ environmentId: 'build01' })

    const created = await controller.create({ path: REMOTE_ROOT })

    expect(created).toMatchObject({
      created: true,
      workspace: { transport: 'ssh', environmentId: 'build01', path: REMOTE_ROOT },
    })
  })

  it('registers an inline SSH destination without a named environment', async () => {
    const { controller } = await harness()

    const created = await controller.create({ path: REMOTE_ROOT })

    expect(created.workspace).toMatchObject({ transport: 'ssh', path: REMOTE_ROOT })
    expect(created.workspace.environmentId).toBeUndefined()
  })
})
