// @vitest-environment jsdom
/**
 * The Telegram page: how its controller projects and converts the ten fields
 * it edits, and how the form renders them — or the unavailable line while the
 * namespace is not served.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { TelegramCard } from '../src/client/TelegramCard.tsx'
import type { TelegramCardProps } from '../src/client/TelegramCard.tsx'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import { en } from '../src/client/locales.ts'
import { TelegramCardController, type TelegramSettings } from '../src/client/telegram-card-controller.ts'
import type { TelegramCardState } from '../src/client/telegram-card-controller.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubSettingsScope<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

/** The ten field names in the order the card renders them. */
const fields = [
  'tokenRef', 'apiBase', 'defaultWorkspace', 'pollTimeoutMs', 'queueCap',
  'editIntervalMs', 'approvalTimeoutMs', 'allowedChatIds', 'allowedUserIds', 'workspaceRoots',
] as const

describe('TelegramCardController', () => {
  it('projects every field from the served section', () => {
    const host = stubSettingsScope<TelegramSettings>()
    const controller = new TelegramCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: {
        tokenRef: 'BOT_TOKEN',
        apiBase: 'https://api.telegram.test',
        defaultWorkspace: '/work',
        pollTimeoutMs: 30_000,
        queueCap: 16,
        editIntervalMs: 500,
        approvalTimeoutMs: 120_000,
        allowedChatIds: [1, 2, 3],
        allowedUserIds: [7, 8],
        workspaceRoots: ['/a', '/b'],
      },
      base: {},
      user: {},
    })
    const face = controller.inject()

    expect(face.hooks.telegramCard.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      tokenRef: { text: 'BOT_TOKEN', overridden: false, invalid: false },
      apiBase: { text: 'https://api.telegram.test', overridden: false, invalid: false },
      defaultWorkspace: { text: '/work', overridden: false, invalid: false },
      pollTimeoutMs: { text: '30000', overridden: false, invalid: false },
      queueCap: { text: '16', overridden: false, invalid: false },
      editIntervalMs: { text: '500', overridden: false, invalid: false },
      approvalTimeoutMs: { text: '120000', overridden: false, invalid: false },
      allowedChatIds: { text: '1, 2, 3', overridden: false, invalid: false },
      allowedUserIds: { text: '7, 8', overridden: false, invalid: false },
      workspaceRoots: { text: '/a, /b', overridden: false, invalid: false },
    })
  })

  it('renders an absent list as an empty draft', () => {
    const host = stubSettingsScope<TelegramSettings>()
    const controller = new TelegramCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: undefined })
    const face = controller.inject()

    expect(face.hooks.telegramCard.getSnapshot()).toMatchObject({
      allowedChatIds: { text: '', overridden: false, invalid: false },
      allowedUserIds: { text: '', overridden: false, invalid: false },
      workspaceRoots: { text: '', overridden: false, invalid: false },
    })
  })

  it('writes comma-separated numbers for the id fields and strings for the roots', async () => {
    const host = stubSettingsScope<TelegramSettings>()
    acceptWrites(host)
    const controller = new TelegramCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('allowedChatIds', ' 1, 2, , 3 ')
    face.edit('allowedUserIds', '7,8')
    face.edit('workspaceRoots', ' /a, /b ,, /c ')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledTimes(3) })

    expect(host.set.mock.calls).toEqual([
      ['allowedChatIds', [1, 2, 3]],
      ['allowedUserIds', [7, 8]],
      ['workspaceRoots', ['/a', '/b', '/c']],
    ])
  })

  it('blocks a save when a number-list entry is not numeric', () => {
    const host = stubSettingsScope<TelegramSettings>()
    acceptWrites(host)
    const controller = new TelegramCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('allowedChatIds', '1, chat')

    expect(face.hooks.telegramCard.getSnapshot().allowedChatIds)
      .toEqual({ text: '1, chat', overridden: false, invalid: true })
    face.save()
    expect(host.set).not.toHaveBeenCalled()
    expect(host.unset).not.toHaveBeenCalled()
  })

  it('clears both list kinds by emptying them', async () => {
    const host = stubSettingsScope<TelegramSettings>()
    acceptWrites(host)
    const controller = new TelegramCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { allowedChatIds: [1, 2], workspaceRoots: ['/a'] },
      base: {},
      user: { allowedChatIds: [1, 2], workspaceRoots: ['/a'] },
    })
    const face = controller.inject()

    face.edit('allowedChatIds', '')
    face.edit('workspaceRoots', '')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledTimes(2) })

    expect(host.unset.mock.calls).toEqual([['allowedChatIds'], ['workspaceRoots']])
  })

  it('stages a reset and applies it on save for a list field', async () => {
    const host = stubSettingsScope<TelegramSettings>()
    acceptWrites(host)
    const controller = new TelegramCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { allowedChatIds: [1] },
      base: { allowedChatIds: [1] },
      user: { allowedChatIds: [1] },
    })
    const face = controller.inject()

    face.resetField('allowedChatIds')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledWith('allowedChatIds') })

    expect(face.hooks.telegramCard.getSnapshot()).toMatchObject({
      dirty: false,
      allowedChatIds: { text: '1', overridden: false },
    })
  })

  it('discards staged edits without writing', () => {
    const host = stubSettingsScope<TelegramSettings>()
    const controller = new TelegramCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { queueCap: 4 }, user: {} })
    const face = controller.inject()

    face.edit('queueCap', '8')
    face.discard()

    expect(face.hooks.telegramCard.getSnapshot().queueCap.text).toBe('4')
    expect(host.set).not.toHaveBeenCalled()
  })
})

/** A settled form: nothing staged, everything served. */
const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

/** One control's state, defaulting to an inherited value. */
function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

/** The form actions every page's slot entry injects. */
function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

/** A settled Telegram form state with every field inherited and empty. */
function telegramState(state: Partial<TelegramCardState> = {}): TelegramCardState {
  return {
    ...settled,
    tokenRef: field(''),
    apiBase: field(''),
    defaultWorkspace: field(''),
    pollTimeoutMs: field(''),
    queueCap: field(''),
    editIntervalMs: field(''),
    approvalTimeoutMs: field(''),
    allowedChatIds: field(''),
    allowedUserIds: field(''),
    workspaceRoots: field(''),
    ...state,
  }
}

function renderTelegram(state: Partial<TelegramCardState> = {}) {
  const store = createSnapshotStore<TelegramCardState>(telegramState(state))
  const actions = cardActions()
  const props = { ...actions, view: 'page', t, useTelegramCard: bindSnapshotSelector(store) } as unknown as TelegramCardProps
  render(<TelegramCard {...props} />)
  return actions
}

describe('TelegramCard', () => {
  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<TelegramCardState>(telegramState())
    const props = {
      ...cardActions(), view: 'summary', t, useTelegramCard: bindSnapshotSelector(store),
    } as unknown as TelegramCardProps
    render(<TelegramCard {...props} />)

    expect(document.body.textContent).toBe(en.telegramDescription)
    expect(screen.queryByLabelText(en.telegramTokenRef)).toBeNull()
  })

  it('says the namespace is unserved in place of its controls', () => {
    renderTelegram({ available: false })

    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    expect(screen.queryByLabelText(en.telegramTokenRef)).toBeNull()
  })

  it('renders all ten fields on its page', () => {
    renderTelegram()

    expect(screen.getByLabelText(en.telegramTokenRef)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramApiBase)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramDefaultWorkspace)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramPollTimeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramQueueCap)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramEditIntervalMs)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramApprovalTimeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramAllowedChatIds)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramAllowedUserIds)).toBeTruthy()
    expect(screen.getByLabelText(en.telegramWorkspaceRoots)).toBeTruthy()
  })

  it('addresses each field with its own edit and reset', () => {
    const overridden = Object.fromEntries(fields.map(name => [name, field(name, { overridden: true })]))
    const actions = renderTelegram(overridden)

    fireEvent.change(screen.getByLabelText(en.telegramTokenRef), { target: { value: 'NEW' } })
    fireEvent.change(screen.getByLabelText(en.telegramApiBase), { target: { value: 'https://x' } })
    fireEvent.change(screen.getByLabelText(en.telegramDefaultWorkspace), { target: { value: '/w' } })
    fireEvent.change(screen.getByLabelText(en.telegramPollTimeoutMs), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(en.telegramQueueCap), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(en.telegramEditIntervalMs), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(en.telegramApprovalTimeoutMs), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(en.telegramAllowedChatIds), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText(en.telegramAllowedUserIds), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText(en.telegramWorkspaceRoots), { target: { value: '/r' } })

    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(fields.length)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['tokenRef', 'NEW'],
      ['apiBase', 'https://x'],
      ['defaultWorkspace', '/w'],
      ['pollTimeoutMs', '1'],
      ['queueCap', '2'],
      ['editIntervalMs', '3'],
      ['approvalTimeoutMs', '4'],
      ['allowedChatIds', '5'],
      ['allowedUserIds', '6'],
      ['workspaceRoots', '/r'],
    ])
    expect(actions.resetField.mock.calls).toEqual(fields.map(name => [name]))
  })

  it('saves only while an edit is staged and valid', () => {
    renderTelegram()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)

    cleanup()

    const staged = renderTelegram({ dirty: true })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(staged.save).toHaveBeenCalledOnce()
  })
})
