import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryListing, DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryPickerController } from '../src/directory-picker.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A backend serving exactly the capability one case is about. */
class StubPicker extends DirectoryPicker {
  static capabilityStub: DirectoryPickerCapability = { kind: 'native', pick: async () => null }

  capability(): DirectoryPickerCapability {
    return StubPicker.capabilityStub
  }
}

const NATIVE_STUB: DirectoryPickerCapability = { kind: 'native', pick: async () => null }

/** One listing level answered for a requested path, in the seam's vocabulary. */
function level(target: string) {
  return {
    path: target,
    home: '/home/user',
    crumbs: [{ name: '/', path: '/', hidden: false }],
    entries: [{ name: 'projects', path: `${target}/projects`, hidden: false }],
    truncated: false,
  }
}

/** Browse capability with environment-scoped primitives. */
const BROWSE_STUB: DirectoryPickerCapability = {
  kind: 'browse',
  list: async (path) => {
    if (path === '/denied') {
      throw new DirectoryPickerError('directory-unreadable', '/denied', 'cannot list /denied')
    }
    return level(path ?? '/home/user')
  },
  createDirectory: async (path, name) => {
    if (name === 'taken') {
      throw new DirectoryPickerError('directory-exists', `${path}/${name}`, 'already exists')
    }
    if (name === 'unwritable') throw new Error('disk detached')
    if (name === 'gone') throw 'the volume vanished'
    return `${path}/${name}`
  },
  listIn: async (_environmentId, path) => {
    if (path === '/denied') {
      throw new DirectoryPickerError('directory-unreadable', '/denied', 'cannot list /denied')
    }
    return level(path ?? '/home/alice')
  },
  createDirectoryIn: async (_environmentId, path, name) => {
    if (name === 'taken') {
      throw new DirectoryPickerError('directory-exists', `${path}/${name}`, 'already exists')
    }
    if (name === 'unwritable') throw new Error('disk detached')
    return `${path}/${name}`
  },
}

/** Browse capability WITHOUT the environment-scoped primitives. */
const BROWSE_BASIC_STUB: DirectoryPickerCapability = {
  kind: 'browse',
  list: async path => level(path ?? '/home/user'),
  createDirectory: async (path, name) => `${path}/${name}`,
}

async function harness(capability: DirectoryPickerCapability = NATIVE_STUB) {
  StubPicker.capabilityStub = capability
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(StubPicker).await()
  return new DirectoryPickerController(ctx)
}

/** The failure payload a refused wire verb carries. */
async function refused(call: Promise<unknown>): Promise<{ code: string; message: string; details: object }> {
  try {
    await call
  } catch (error: unknown) {
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return { code: failure.code, message: failure.message, details: failure.details }
  }
  throw new Error('the call was expected to be refused')
}

describe('directoryPicker pick Remote', () => {
  it('answers the selected path or the operator\'s cancellation', async () => {
    const selected = await harness({ kind: 'native', pick: async () => '/tmp/project' })
    expect(await selected.pick(new AbortController().signal)).toBe('/tmp/project')

    const cancelled = await harness(NATIVE_STUB)
    expect(await cancelled.pick(new AbortController().signal)).toBeNull()
  })

  it('reports an aborted chooser as cancelled and any other failure as internal', async () => {
    const picker = await harness({
      kind: 'native',
      pick: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = refused(picker.pick(abort.signal))
    abort.abort()
    expect((await pending).code).toBe('gateway/cancelled')

    const broken = await harness({ kind: 'native', pick: async () => { throw new Error('no chooser installed') } })
    const failure = await refused(broken.pick(new AbortController().signal))
    expect(failure.code).toBe('gateway/internal')
    expect(failure.message).toContain('no chooser installed')
  })

  it('refuses the native verb under a browse composition', async () => {
    const picker = await harness(BROWSE_STUB)
    const failure = await refused(picker.pick(new AbortController().signal))
    expect(failure.code).toBe('directory-picker/unavailable')
    expect(failure.message).toContain('needs the native capability')
    expect(failure.details).toEqual({ capability: 'browse' })
  })
})

describe('directoryPicker browse Remotes', () => {
  it('serves listings and creation, defaulting to the home directory', async () => {
    const picker = await harness(BROWSE_STUB)
    const signal = new AbortController().signal
    expect(await picker.list(undefined, signal)).toMatchObject({ path: '/home/user', home: '/home/user' })
    expect(await picker.list('/home/user/projects', signal))
      .toMatchObject({ path: '/home/user/projects' })
    expect(await picker.createDirectory('/home/user', 'fresh')).toBe('/home/user/fresh')
  })

  it('serves environment-scoped listings and creation', async () => {
    const picker = await harness(BROWSE_STUB)
    const signal = new AbortController().signal
    expect(await picker.listIn('bsdev', undefined, signal)).toMatchObject({ path: '/home/alice' })
    expect(await picker.listIn('bsdev', '/srv/app', signal)).toMatchObject({ path: '/srv/app' })
    expect(await picker.createDirectoryIn('bsdev', '/srv/app', 'fresh')).toBe('/srv/app/fresh')
  })

  it('maps environment-scoped failures onto the same wire codes', async () => {
    const picker = await harness(BROWSE_STUB)
    expect(await refused(picker.listIn('bsdev', '/denied', new AbortController().signal)))
      .toMatchObject({ code: 'directory-picker/unreadable', details: { path: '/denied' } })
    expect((await refused(picker.createDirectoryIn('bsdev', '/srv', 'taken'))).code).toBe('directory-picker/exists')
    expect((await refused(picker.createDirectoryIn('bsdev', '/srv', 'unwritable'))).code).toBe('gateway/internal')
  })

  it('reports an aborted environment listing as cancelled', async () => {
    const picker = await harness({
      kind: 'browse',
      list: (path, signal) => BROWSE_STUB.list(path, signal),
      createDirectory: (path, name) => BROWSE_STUB.createDirectory(path, name),
      listIn: (_environmentId: string, _path: string | undefined, signal?: AbortSignal): Promise<DirectoryListing> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('scan aborted')) }, { once: true })
        }),
      createDirectoryIn: (environmentId, path, name) => BROWSE_STUB.createDirectoryIn!(environmentId, path, name),
    })
    const abort = new AbortController()
    const pending = refused(picker.listIn('bsdev', undefined, abort.signal))
    abort.abort()
    expect((await pending).code).toBe('gateway/cancelled')
  })

  it('refuses environment-scoped verbs the composed backend does not serve', async () => {
    const picker = await harness(BROWSE_BASIC_STUB)
    expect(await refused(picker.listIn('bsdev', '/srv', new AbortController().signal)))
      .toMatchObject({ code: 'directory-picker/unavailable', details: { capability: 'listIn' } })
    expect(await refused(picker.createDirectoryIn('bsdev', '/srv', 'child')))
      .toMatchObject({ code: 'directory-picker/unavailable', details: { capability: 'createDirectoryIn' } })
  })

  it('maps the seam\'s typed failures and folds unknown throws to internal', async () => {
    const picker = await harness(BROWSE_STUB)
    expect(await refused(picker.list('/denied', new AbortController().signal)))
      .toMatchObject({ code: 'directory-picker/unreadable', details: { path: '/denied' } })
    expect((await refused(picker.createDirectory('/home/user', 'taken'))).code).toBe('directory-picker/exists')
    expect((await refused(picker.createDirectory('/home/user', 'unwritable'))).code).toBe('gateway/internal')

    const thrown = await refused(picker.createDirectory('/home/user', 'gone'))
    expect(thrown).toMatchObject({ code: 'gateway/internal', message: 'the volume vanished' })
  })

  it('rejects invalid child names before capability dispatch', async () => {
    const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
    const createDirectoryIn = vi.fn(async (_environmentId: string, path: string, name: string) => `${path}/${name}`)
    const picker = await harness({
      kind: 'browse',
      list: (path, signal) => BROWSE_STUB.list(path, signal),
      createDirectory,
      listIn: (environmentId, path, signal) => BROWSE_STUB.listIn!(environmentId, path, signal),
      createDirectoryIn,
    })

    for (const name of ['', ' ', '.', '..', 'a/b', 'a\\b']) {
      const failure = await refused(picker.createDirectory('/home/user', name))
      expect(failure).toMatchObject({
        code: 'gateway/bad-request',
        message: 'invalid payload for host.createDirectory',
      })
      expect(Array.isArray(Reflect.get(failure.details, 'issues'))).toBe(true)

      const scoped = await refused(picker.createDirectoryIn('bsdev', '/srv', name))
      expect(scoped).toMatchObject({
        code: 'gateway/bad-request',
        message: 'invalid payload for host.createDirectoryIn',
      })
    }
    expect(createDirectory).not.toHaveBeenCalled()
    expect(createDirectoryIn).not.toHaveBeenCalled()
  })

  it('reports an aborted listing as cancelled', async () => {
    const picker = await harness({
      kind: 'browse',
      list: (_path, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('scan aborted')) }, { once: true })
      }),
      createDirectory: async () => '/never',
    })
    const abort = new AbortController()
    const pending = refused(picker.list(undefined, abort.signal))
    abort.abort()
    expect((await pending).code).toBe('gateway/cancelled')
  })

  it('refuses the browse verbs under a native composition', async () => {
    const picker = await harness()
    expect(await refused(picker.list(undefined, new AbortController().signal)))
      .toMatchObject({ code: 'directory-picker/unavailable', details: { capability: 'native' } })
    expect(await refused(picker.createDirectory('/x', 'y')))
      .toMatchObject({ code: 'directory-picker/unavailable', details: { capability: 'native' } })
  })
})
