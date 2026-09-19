// @vitest-environment jsdom
/**
 * The SSH environments page: how its controller projects, stages, and writes
 * the environment map, and how the form renders those rows — including the
 * unserved namespace, the empty map, and a row no Host would accept.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { SshEnvironmentsCard } from '../src/client/SshEnvironmentsCard.tsx'
import type { SshEnvironmentsCardProps } from '../src/client/SshEnvironmentsCard.tsx'
import type { CardShell } from '../src/client/card-form.ts'
import { en } from '../src/client/locales.ts'
import {
  SshEnvironmentsCardController,
  type SshEnvironmentRow,
  type SshEnvironmentSetting,
  type SshEnvironmentsCardState,
  type SshEnvironmentsSettings,
} from '../src/client/ssh-environments-card-controller.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

/** A served namespace holding the given environments, with accepted writes published back. */
function serve(environments: Record<string, SshEnvironmentSetting>) {
  const host = stubSettingsScope<SshEnvironmentsSettings>()
  host.publish({ status: 'ready', writable: true, value: { environments }, base: {}, user: {} })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...host.scope.getSnapshot().value, [field]: value } })
  })
  return host
}

describe('SshEnvironmentsCardController', () => {
  it('projects the configured environments, and no rows before the map arrives', () => {
    const host = serve({ build01: { host: 'build01.example' }, build02: { host: '10.0.0.2' } })
    const face = new SshEnvironmentsCardController(host.scope).inject()

    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      invalid: false,
      rows: [
        { key: 'build01', id: 'build01', idInvalid: false, host: 'build01.example', hostInvalid: false },
        { key: 'build02', id: 'build02', idInvalid: false, host: '10.0.0.2', hostInvalid: false },
      ],
    })
  })

  it('projects an unserved namespace and a section without the map as no rows', () => {
    const host = stubSettingsScope<SshEnvironmentsSettings>()
    const face = new SshEnvironmentsCardController(host.scope).inject()
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({ available: false, rows: [] })

    host.publish({ status: 'ready', writable: false, value: {}, base: {}, user: undefined })
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      available: true, writable: false, rows: [],
    })
  })

  it('stages a new row, refuses it while unnamed, and writes it once named', async () => {
    const host = serve({})
    const controller = new SshEnvironmentsCardController(host.scope)
    const face = controller.inject()

    face.add()
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: true,
      rows: [{ id: '', idInvalid: true, host: '', hostInvalid: true }],
    })

    face.editId('new-0', 'build03')
    face.editHost('new-0', 'build03.example')
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: false,
      rows: [{ id: 'build03', idInvalid: false, host: 'build03.example', hostInvalid: false }],
    })

    await controller.save()

    expect(host.set).toHaveBeenCalledWith('environments', { build03: { host: 'build03.example' } })
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      dirty: false, rows: [{ key: 'build03', id: 'build03' }],
    })
  })

  it('writes back the options a row does not edit', async () => {
    const host = serve({ build01: { host: 'old.example', identityFile: '/keys/build01' } })
    const controller = new SshEnvironmentsCardController(host.scope)
    const face = controller.inject()

    face.editHost('build01', 'new.example')
    await controller.save()

    expect(host.set).toHaveBeenCalledWith('environments', {
      build01: { host: 'new.example', identityFile: '/keys/build01' },
    })
  })

  it('refuses a save whose rows share an identifier', async () => {
    const host = serve({ build01: { host: 'build01.example' } })
    const controller = new SshEnvironmentsCardController(host.scope)
    const face = controller.inject()

    face.add()
    face.editId('new-0', 'build01')
    face.editHost('new-0', 'build02.example')
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      invalid: true, rows: [{ idInvalid: true }, { idInvalid: true }],
    })

    await controller.save()

    expect(host.set).not.toHaveBeenCalled()
  })

  it('flags an identifier and a destination OpenSSH cannot use', () => {
    const host = serve({})
    const controller = new SshEnvironmentsCardController(host.scope)
    const face = controller.inject()

    face.add()
    face.editId('new-0', 'build 03')
    face.editHost('new-0', 'build 03')

    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      rows: [{ idInvalid: true, hostInvalid: true }],
    })
  })

  it('drops a row, and clears every staged row on discard', () => {
    const host = serve({ build01: { host: 'build01.example' } })
    const face = new SshEnvironmentsCardController(host.scope).inject()

    face.add()
    face.editId('new-0', 'build02')
    face.editHost('new-0', 'build02.example')
    face.remove('build01')
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      dirty: true, rows: [{ key: 'new-0', id: 'build02' }],
    })

    face.discard()
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({
      dirty: false, rows: [{ key: 'build01', id: 'build01' }],
    })

    // Nothing staged and nothing failed: a second discard republishes nothing.
    const settled = face.hooks.sshEnvironmentsCard.getSnapshot()
    face.discard()
    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toBe(settled)
  })

  it('writes nothing when no row was staged', async () => {
    const host = serve({ build01: { host: 'build01.example' } })
    const controller = new SshEnvironmentsCardController(host.scope)

    await controller.save()

    expect(host.set).not.toHaveBeenCalled()
  })

  it('writes through the action surface the slot entry injects', async () => {
    const host = serve({})
    const face = new SshEnvironmentsCardController(host.scope).inject()

    face.add()
    face.editId('new-0', 'build04')
    face.editHost('new-0', 'build04.example')
    face.save()

    await vi.waitFor(() => {
      expect(host.set).toHaveBeenCalledWith('environments', { build04: { host: 'build04.example' } })
    })
  })

  it('keeps its drafts when the Host stored a different key set', async () => {
    const host = serve({ build01: { host: 'build01.example' } })
    const controller = new SshEnvironmentsCardController(host.scope)
    const face = controller.inject()
    host.set.mockImplementation(() => {
      host.publish({ value: {} })
    })

    face.editHost('build01', 'new.example')
    await controller.save()

    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({ dirty: true, failed: true })
  })

  it('keeps its drafts when the Host stored a different key', async () => {
    const host = serve({ build01: { host: 'build01.example' } })
    const controller = new SshEnvironmentsCardController(host.scope)
    const face = controller.inject()
    host.set.mockImplementation(() => {
      host.publish({ value: { environments: { other: { host: 'new.example' } } } })
    })

    face.editHost('build01', 'new.example')
    await controller.save()

    expect(face.hooks.sshEnvironmentsCard.getSnapshot()).toMatchObject({ dirty: true, failed: true })
  })

  it('ignores a save while one is crossing the wire', async () => {
    const host = serve({ build01: { host: 'build01.example' } })
    const controller = new SshEnvironmentsCardController(host.scope)
    const face = controller.inject()
    const pending = Promise.withResolvers<undefined>()
    host.set.mockReturnValue(pending.promise)

    face.editHost('build01', 'new.example')
    const first = controller.save()
    const second = controller.save()
    pending.resolve(undefined)
    await first
    await second

    expect(host.set).toHaveBeenCalledTimes(1)
  })
})

/** A settled form: nothing staged, everything served. */
const settled: CardShell = {
  available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
}

/** One environment row, valid unless the caller says otherwise. */
function row(rest: Partial<SshEnvironmentRow> = {}): SshEnvironmentRow {
  return { key: 'build01', id: 'build01', idInvalid: false, host: 'build01.example', hostInvalid: false, ...rest }
}

/** The row actions every page's slot entry injects. */
function cardActions() {
  return { add: vi.fn(), remove: vi.fn(), editId: vi.fn(), editHost: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

/** Render the page with one configured environment unless the caller replaces it. */
function renderCard(state: Partial<SshEnvironmentsCardState> = {}, view: 'page' | 'summary' = 'page') {
  const store = createSnapshotStore<SshEnvironmentsCardState>({ ...settled, rows: [row()], ...state })
  const actions = cardActions()
  const props = {
    ...actions, view, t, useSshEnvironmentsCard: bindSnapshotSelector(store),
  } as unknown as SshEnvironmentsCardProps
  render(<SshEnvironmentsCard {...props} />)
  return actions
}

describe('SshEnvironmentsCard', () => {
  it('renders its one-liner alone in the summary view', () => {
    renderCard({}, 'summary')

    expect(document.body.textContent).toBe(en.sshEnvironmentsDescription)
    expect(screen.queryByLabelText(en.sshEnvironmentId)).toBeNull()
  })

  it('says the namespace is unserved in place of its rows', () => {
    renderCard({ available: false })

    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    expect(screen.queryByLabelText(en.sshEnvironmentId)).toBeNull()
  })

  it('says so while no environment is configured', () => {
    renderCard({ rows: [] })

    expect(screen.getByRole('status').textContent).toBe(en.sshEnvironmentsEmpty)
  })

  it('stages a row edit, its removal, and a new row', () => {
    const actions = renderCard()

    fireEvent.change(screen.getByLabelText(en.sshEnvironmentId), { target: { value: 'build02' } })
    fireEvent.change(screen.getByLabelText(en.sshEnvironmentHost), { target: { value: 'build02.example' } })
    fireEvent.click(screen.getByRole('button', { name: en.sshEnvironmentRemove }))
    fireEvent.click(screen.getByRole('button', { name: en.sshEnvironmentsAdd }))

    expect(actions.editId).toHaveBeenCalledWith('build01', 'build02')
    expect(actions.editHost).toHaveBeenCalledWith('build01', 'build02.example')
    expect(actions.remove).toHaveBeenCalledWith('build01')
    expect(actions.add).toHaveBeenCalledTimes(1)
  })

  it('marks a row no Host would accept', () => {
    renderCard({ rows: [row({ idInvalid: true, hostInvalid: true })] })

    expect(screen.getAllByText(en.sshEnvironmentRowInvalid)).toHaveLength(2)
    expect(screen.getByLabelText(en.sshEnvironmentId).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText(en.sshEnvironmentHost).getAttribute('aria-invalid')).toBe('true')
  })

  it('disables every control while the document is read-only', () => {
    renderCard({ writable: false })

    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByLabelText(en.sshEnvironmentId)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.sshEnvironmentsAdd })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.sshEnvironmentRemove })).toHaveProperty('disabled', true)
  })
})
