// @vitest-environment jsdom
/** Environment selection and late-response ownership in the workspace panel. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Environments, EnvironmentsIcon, type EnvironmentsProps } from '../src/client/Environments.tsx'
import { en } from '../src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { EnvironmentTarget, EnvironmentWorkspace, WorkspaceRequest, WorkspaceResult } from '../src/workspace-types.ts'

afterEach(cleanup)
const windows = brandString<EnvironmentTarget['environmentId']>('11111111-1111-4111-8111-111111111111')
const linux = brandString<EnvironmentTarget['environmentId']>('22222222-2222-4222-8222-222222222222')
const dictionary = { ...common, ...en }
const t: EnvironmentsProps['t'] = key => dictionary[key]
const targets: EnvironmentTarget[] = [{ environmentId: windows, label: 'Windows', local: true, status: 'online' }, { environmentId: linux, label: 'Linux', local: false, status: 'online' }]
const catalog = (path: string): WorkspaceResult => ({ kind: 'catalog', roots: [{ alias: 'project', path }], workspaces: [], truncated: false })
const directory: WorkspaceResult = { kind: 'directory', alias: 'project', relativePath: '', path: '/srv/project', entries: [], truncated: false }

it('creates and registers a remote workspace using the selected environment and relative directory', async () => {
  const workspace = vi.fn(async (id: EnvironmentTarget['environmentId'], request: WorkspaceRequest): Promise<WorkspaceResult> => {
    if (request.action === 'catalog') return catalog(id === windows ? 'C:/project' : '/srv/project')
    if (request.action === 'browse') return directory
    if (request.action === 'mkdir') return { ...directory, relativePath: 'new-project', path: '/srv/project/new-project' }
    return { kind: 'registered', workspace: { environmentId: linux, workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('workspace-linux'), alias: 'project', relativePath: 'new-project', path: '/srv/project/new-project', title: 'new-project' } }
  })
  const notify = vi.fn()
  const result = render(<Environments t={t} environments={async () => targets} workspace={workspace} notify={notify} />)
  await screen.findByText('C:/project')
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: linux } })
  await screen.findByText('/srv/project')
  expect(screen.queryByText('C:/project')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
  await screen.findByText('No subfolders in this directory.')
  fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'new-project' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))
  await screen.findByText('/srv/project/new-project')
  expect(workspace).toHaveBeenCalledWith(linux, { action: 'mkdir', alias: 'project', relativePath: '', name: 'new-project' })
  fireEvent.click(screen.getByRole('button', { name: 'Use as workspace' }))
  await screen.findByText('new-project')
  expect(workspace).toHaveBeenCalledWith(linux, { action: 'register', alias: 'project', relativePath: 'new-project' })
  expect(notify.mock.calls).toEqual([['folderCreated'], ['workspaceSaved']])
  await expect(result.container.textContent).toMatchFileSnapshot('./expected/remote-workspace.txt')
  fireEvent.click(screen.getByRole('button', { name: 'All workspaces' }))
  await screen.findByText(en.grantedDirectories)
})

it('navigates registered workspaces, children and parent folders with truncation visible', async () => {
  const registered: EnvironmentWorkspace = { environmentId: linux, workspaceId: brandString<EnvironmentWorkspace['workspaceId']>('remote'), alias: 'project', relativePath: 'child', path: '/srv/project/child', title: 'Child project' }
  const workspace = vi.fn<EnvironmentsProps['workspace']>().mockResolvedValueOnce({ kind: 'catalog', roots: [], workspaces: [registered], truncated: true })
    .mockResolvedValueOnce({ ...directory, relativePath: 'child', path: registered.path, entries: [{ name: 'nested', relativePath: 'child/nested' }], truncated: true })
    .mockResolvedValueOnce({ ...directory, relativePath: 'child/nested', path: '/srv/project/child/nested' })
    .mockResolvedValueOnce(directory).mockResolvedValue(catalog('/srv/project'))
  render(<><EnvironmentsIcon size={16} />
    <Environments t={t} environments={async () => [targets[1]!]} workspace={workspace} notify={vi.fn()} /></>)
  await screen.findByText('Child project')
  expect(screen.getByText(en.truncated)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
  await screen.findByText('nested')
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
  await screen.findByText('/srv/project/child/nested')
  fireEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
  await screen.findByText('/srv/project')
  expect(workspace).toHaveBeenLastCalledWith(linux, { action: 'browse', alias: 'project', relativePath: 'child' })
  fireEvent.click(screen.getByRole('button', { name: 'All workspaces' }))
  await screen.findByText(en.grantedDirectories)
})

it('retains a discovered label when a peer becomes unavailable and reports a failed browse', async () => {
  const environments = vi.fn<EnvironmentsProps['environments']>().mockResolvedValueOnce([targets[1]!]).mockResolvedValue([{ ...targets[1]!, label: linux, status: 'unavailable' }, { ...targets[0]!, local: false, status: 'unavailable' }])
  const workspace = vi.fn<EnvironmentsProps['workspace']>().mockResolvedValue(catalog('/remote'))
  render(<Environments t={t} environments={environments} workspace={workspace} notify={vi.fn()} />)
  await screen.findByText('/remote')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('option', { name: /Linux.*Unavailable/ })
  workspace.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
  await screen.findByRole('alert')
  expect(screen.getByText('/remote')).toBeTruthy()
})

it.each(['resolve', 'reject'] as const)('ignores discovery %s after unmount', async (outcome) => {
  let resolve!: (value: EnvironmentTarget[]) => void
  let reject!: (error: Error) => void
  const pending = new Promise<EnvironmentTarget[]>((yes, no) => { resolve = yes; reject = no })
  const workspace = vi.fn<EnvironmentsProps['workspace']>()
  const page = render(<Environments t={t} environments={() => pending} workspace={workspace} notify={vi.fn()} />)
  page.unmount()
  await act(async () => { if (outcome === 'resolve') resolve(targets); else reject(new Error('offline')); await pending.catch(() => {}) })
  expect(workspace).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)('ignores mutation %s after unmount', async (outcome) => {
  let resolve!: (value: WorkspaceResult) => void
  let reject!: (error: Error) => void
  const pending = new Promise<WorkspaceResult>((yes, no) => { resolve = yes; reject = no })
  const workspace = vi.fn<EnvironmentsProps['workspace']>().mockResolvedValueOnce(directory).mockReturnValueOnce(pending)
  const notify = vi.fn()
  const page = render(<Environments t={t} environments={async () => targets} workspace={workspace} notify={notify} />)
  await screen.findByText('/srv/project')
  fireEvent.click(screen.getByRole('button', { name: 'Use as workspace' }))
  page.unmount()
  await act(async () => { if (outcome === 'resolve') resolve(directory); else reject(new Error('offline')); await pending.catch(() => {}) })
  expect(notify).not.toHaveBeenCalled()
})

it('ignores a late response from the previously selected environment', async () => {
  let resolveLocal!: (result: WorkspaceResult) => void
  const local = new Promise<WorkspaceResult>((resolve) => { resolveLocal = resolve })
  const workspace = vi.fn(async (id: EnvironmentTarget['environmentId']) => id === windows ? local : catalog('/remote'))
  render(<Environments t={t} environments={async () => targets} workspace={workspace} notify={vi.fn()} />)
  await waitFor(() => { expect(workspace).toHaveBeenCalledWith(windows, { action: 'catalog' }) })
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: linux } })
  await screen.findByText('/remote')
  resolveLocal(catalog('C:/stale'))
  await waitFor(() => { expect(screen.getByText('/remote')).toBeTruthy() })
  expect(screen.queryByText('C:/stale')).toBeNull()
})

it('prevents duplicate registration before the pending state renders', async () => {
  let resolve!: (value: WorkspaceResult) => void
  const pending = new Promise<WorkspaceResult>((yes) => { resolve = yes })
  const workspace = vi.fn<EnvironmentsProps['workspace']>().mockResolvedValueOnce(directory).mockReturnValue(pending)
  render(<Environments t={t} environments={async () => targets} workspace={workspace} notify={vi.fn()} />)
  await screen.findByText('/srv/project')
  const button = screen.getByRole('button', { name: 'Use as workspace' })
  act(() => { button.click(); button.click() })
  expect(workspace).toHaveBeenCalledTimes(2)
  await act(async () => { resolve(directory); await pending })
})

it('ignores a late failed catalog after selecting another machine', async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<WorkspaceResult>((_yes, no) => { reject = no })
  const workspace = vi.fn<EnvironmentsProps['workspace']>().mockReturnValueOnce(pending).mockResolvedValue(catalog('/remote'))
  render(<Environments t={t} environments={async () => targets} workspace={workspace} notify={vi.fn()} />)
  await waitFor(() => { expect(workspace).toHaveBeenCalledOnce() })
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: linux } })
  await screen.findByText('/remote')
  await act(async () => { reject(new Error('offline')); await pending.catch(() => {}) })
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'removed' } })
  expect(screen.getByText('/remote')).toBeTruthy()
})

it('retains a loaded view on refresh failure and keeps an unsuccessful folder draft', async () => {
  const workspace = vi.fn(async (): Promise<WorkspaceResult> => directory)
  const notify = vi.fn()
  render(<Environments t={t} environments={async () => targets} workspace={workspace} notify={notify} />)
  await screen.findByText('/srv/project')
  workspace.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('alert')
  expect(screen.getByText('/srv/project')).toBeTruthy()
  workspace.mockRejectedValueOnce(new Error('denied'))
  fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'keep-me' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))
  await waitFor(() => { expect(notify).toHaveBeenCalledWith('workspaceFailed') })
  expect(screen.getByLabelText('New folder name')).toHaveProperty('value', 'keep-me')
})

it('shows a discovery failure and retries without substituting an environment', async () => {
  const environments = vi.fn<EnvironmentsProps['environments']>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(targets)
  const workspace = vi.fn(async () => catalog('/ready'))
  render(<Environments t={t} environments={environments} workspace={workspace} notify={vi.fn()} />)
  await screen.findByRole('alert')
  expect(workspace).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('/ready')
})
