/** Client Workspace command facade: value projection and structured failures. */

import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  ClientWorkspaceModel, EnvironmentListError, FileListError, FileReadError, WorkspaceController, WorkspaceCreateError,
} from '../src/client/index.ts'
import type { FileContents, FileListing, WorkspaceEnvironmentView, WorkspaceView } from '../src/types.ts'

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failed = <T>(code: string): RemoteResult<T> => ({
  ok: false,
  // The Remote failure branch is a discriminated union over the code's details;
  // these cases only exercise the facade's operation-naming, so the code is free.
  error: { code, message: `${code} happened`, details: {} } as RemoteFailure,
})

const view = {
  workspaceId: 'w1', transport: 'local', path: '/w/w1', title: 'w1',
  sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as WorkspaceView
const contents: FileContents = { path: '/w/a.txt', content: 'a', truncated: false, binary: false, size: 1 }
const listing: FileListing = { path: '/w', entries: [], truncated: false }

/** The Remote-backed model is stubbed: this suite covers the facade above it. */
function harness() {
  const model = {
    create: vi.fn(async () => ok({ workspace: view, created: true })),
    rename: vi.fn(async () => ok({ workspace: view })),
    delete: vi.fn(async () => ok({ deleted: true })),
    insertBefore: vi.fn(async () => ok({ workspaceIds: [] })),
    archiveSession: vi.fn(async () => ok({ archivedSessionIds: [] })),
    unarchiveSession: vi.fn(async () => ok({ archivedSessionIds: [] })),
    insertSessionBefore: vi.fn(async () => ok({ workspace: view })),
    readFile: vi.fn(async () => ok(contents)),
    listFiles: vi.fn(async () => ok(listing)),
    environments: vi.fn(async (): Promise<RemoteResult<WorkspaceEnvironmentView[]>> => ok([])),
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const controller = new WorkspaceController(ctx, model as unknown as ClientWorkspaceModel)
  return { controller, model }
}

const wid = (id: string): WorkspaceId => id as WorkspaceId
const sid = (id: string): SessionId => id as SessionId

describe('WorkspaceController (Client face)', () => {
  it('exposes the model snapshot as its list source', async () => {
    const { controller, model } = harness()
    expect(controller.list).toBe(model)
  })

  it('projects created and changed Workspaces and names each command failure', async () => {
    const { controller, model } = harness()
    await expect(controller.create({ path: '/w/w1' })).resolves.toBe(view)
    await expect(controller.rename(wid('w1'), 'renamed')).resolves.toBe(view)
    await expect(controller.insertSessionBefore(wid('w1'), sid('s1'))).resolves.toBe(view)
    await expect(controller.delete(wid('w1'))).resolves.toBeUndefined()
    await expect(controller.insertBefore(wid('w1'))).resolves.toBeUndefined()
    await expect(controller.archiveSession(sid('s1'))).resolves.toBeUndefined()
    await expect(controller.unarchiveSession(sid('s1'))).resolves.toBeUndefined()

    model.create.mockResolvedValueOnce(failed('workspace/invalid-path'))
    model.rename.mockResolvedValueOnce(failed('workspace/not-found'))
    model.delete.mockResolvedValueOnce(failed('workspace/not-found'))
    model.insertBefore.mockResolvedValueOnce(failed('workspace/order-invalid'))
    model.archiveSession.mockResolvedValueOnce(failed('workspace/not-found'))
    model.unarchiveSession.mockResolvedValueOnce(failed('workspace/not-found'))
    model.insertSessionBefore.mockResolvedValueOnce(failed('workspace/not-found'))

    await expect(controller.create({ path: '/w/none' })).rejects.toBeInstanceOf(WorkspaceCreateError)
    await expect(controller.rename(wid('gone'), 'x')).rejects.toThrow(/workspace rename failed: workspace\/not-found/)
    await expect(controller.delete(wid('gone'))).rejects.toThrow(/workspace delete failed/)
    await expect(controller.insertBefore(wid('gone'))).rejects.toThrow(/workspace reorder failed/)
    await expect(controller.archiveSession(sid('gone'))).rejects.toThrow(/workspace session archive failed/)
    await expect(controller.unarchiveSession(sid('gone'))).rejects.toThrow(/workspace session unarchive failed/)
    await expect(controller.insertSessionBefore(wid('gone'), sid('s1'))).rejects.toThrow(/workspace move failed/)
  })

  it('projects file reads and listings and raises their structured failures', async () => {
    const { controller, model } = harness()
    const signal = new AbortController().signal
    await expect(controller.readFile('/w/a.txt', signal)).resolves.toBe(contents)
    await expect(controller.listFiles('/w', signal)).resolves.toBe(listing)

    model.readFile.mockResolvedValueOnce(failed('file-not-found'))
    const readFailure = await controller.readFile('/w/missing.txt').then(() => undefined, (error: unknown) => error)
    expect(readFailure).toBeInstanceOf(FileReadError)
    expect(readFailure).toMatchObject({ name: 'FileReadError', rpcError: { code: 'file-not-found' } })

    model.listFiles.mockResolvedValueOnce(failed('directory-unreadable'))
    const listFailure = await controller.listFiles('/w/gone').then(() => undefined, (error: unknown) => error)
    expect(listFailure).toBeInstanceOf(FileListError)
    expect(listFailure).toMatchObject({ name: 'FileListError', rpcError: { code: 'directory-unreadable' } })
    expect((listFailure as Error).message).toContain('file listing failed: directory-unreadable')
  })

  it('lists the deployment environments and raises their structured failure', async () => {
    const { controller, model } = harness()
    const environment = { environmentId: 'build01', label: 'Build 01', host: 'build01.example', reachable: true }
    model.environments.mockResolvedValueOnce(ok([environment]))

    await expect(controller.environments()).resolves.toEqual([environment])

    model.environments.mockResolvedValueOnce(failed('gateway/bad-request'))
    const failure = await controller.environments().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(EnvironmentListError)
    expect(failure).toMatchObject({ name: 'EnvironmentListError', rpcError: { code: 'gateway/bad-request' } })
    expect((failure as Error).message).toContain('environment listing failed: gateway/bad-request')
  })
})
