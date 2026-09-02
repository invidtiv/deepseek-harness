/**
 * The Telegram card's staged form over the `telegram` settings namespace.
 *
 * The Host half (`@deepseek-ai/dsh-telegram`) serves the namespace; this card
 * only binds it, so a deployment that does not compose that plugin makes the
 * scope report the namespace unavailable and the card renders nothing.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CardForm, numberField, textField, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell } from './card-form.ts'

/**
 * Namespace of the Telegram bot capability. Spelled here rather than imported:
 * a client package must not depend on a Host package.
 */
export const TELEGRAM_NS = 'telegram'

/** The Telegram fields this card edits — a subset of the served schema by design. */
export interface TelegramSettings {
  /** Credential reference naming the bot token. */
  tokenRef?: string
  /** Bot API endpoint; blank inherits the official endpoint. */
  apiBase?: string
  /** Workspace used when a message names none. */
  defaultWorkspace?: string
  /** Chat ids the bot may interact with. */
  allowedChatIds?: number[]
  /** User ids the bot may interact with. */
  allowedUserIds?: number[]
  /** Workspace roots the bot may access. */
  workspaceRoots?: string[]
  /** Long-poll wait for a new message, in milliseconds. */
  pollTimeoutMs?: number
  /** Upper bound on messages waiting to be handled. */
  queueCap?: number
  /** Minimum delay between successive message edits, in milliseconds. */
  editIntervalMs?: number
  /** How long an approval may wait before it expires, in milliseconds. */
  approvalTimeoutMs?: number
}

/** What the Telegram card renders. */
export interface TelegramCardState extends CardShell {
  /** Credential reference naming the bot token. */
  tokenRef: CardFieldState
  /** Bot API endpoint. */
  apiBase: CardFieldState
  /** Workspace used when a message names none. */
  defaultWorkspace: CardFieldState
  /** Chat ids the bot may interact with. */
  allowedChatIds: CardFieldState
  /** User ids the bot may interact with. */
  allowedUserIds: CardFieldState
  /** Workspace roots the bot may access. */
  workspaceRoots: CardFieldState
  /** Long-poll wait for a new message, in milliseconds. */
  pollTimeoutMs: CardFieldState
  /** Upper bound on messages waiting to be handled. */
  queueCap: CardFieldState
  /** Minimum delay between successive message edits, in milliseconds. */
  editIntervalMs: CardFieldState
  /** How long an approval may wait before it expires, in milliseconds. */
  approvalTimeoutMs: CardFieldState
}

/** The registration-side face the Telegram card's slot entry injects. */
export interface TelegramCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useTelegramCard. */
    telegramCard: SnapshotStore<TelegramCardState>
  }
}

/**
 * A comma-separated list of finite numbers. An empty draft clears the field;
 * any non-numeric entry blocks the save.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function numberListField(field: string): CardFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.join(', ') : '',
    parse: (text) => {
      const items = splitList(text)
      if (items.length === 0) return { kind: 'clear' }
      const numbers = items.map(Number)
      return numbers.some(item => !Number.isFinite(item))
        ? undefined
        : { kind: 'set', value: numbers }
    },
  }
}

/**
 * A comma-separated list of strings. An empty draft clears the field; every
 * entry is kept verbatim, so no draft this field accepts is rejected.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function stringListField(field: string): CardFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.join(', ') : '',
    parse: (text) => {
      const items = splitList(text)
      return items.length === 0 ? { kind: 'clear' } : { kind: 'set', value: items }
    },
  }
}

/**
 * Split a comma-separated draft into its trimmed, non-empty entries.
 * @param text - the staged draft text.
 * @returns the entries, in order.
 */
function splitList(text: string): string[] {
  return text.split(',').map(item => item.trim()).filter(item => item.length > 0)
}

/** Bridges the `telegram` scope onto the card's staged form. */
export class TelegramCardController {
  private readonly form: CardForm<TelegramSettings>
  private readonly store: SnapshotStore<TelegramCardState>

  /** @param scope - the bound settings scope for the `telegram` namespace. */
  constructor(scope: SettingsScope<TelegramSettings>) {
    this.form = new CardForm(scope, [
      textField('tokenRef'),
      textField('apiBase'),
      textField('defaultWorkspace'),
      numberField('pollTimeoutMs'),
      numberField('queueCap'),
      numberField('editIntervalMs'),
      numberField('approvalTimeoutMs'),
      numberListField('allowedChatIds'),
      numberListField('allowedUserIds'),
      stringListField('workspaceRoots'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): TelegramCardState {
    return {
      ...this.form.shell(),
      tokenRef: this.form.field('tokenRef'),
      apiBase: this.form.field('apiBase'),
      defaultWorkspace: this.form.field('defaultWorkspace'),
      pollTimeoutMs: this.form.field('pollTimeoutMs'),
      queueCap: this.form.field('queueCap'),
      editIntervalMs: this.form.field('editIntervalMs'),
      approvalTimeoutMs: this.form.field('approvalTimeoutMs'),
      allowedChatIds: this.form.field('allowedChatIds'),
      allowedUserIds: this.form.field('allowedUserIds'),
      workspaceRoots: this.form.field('workspaceRoots'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): TelegramCardFace {
    return { hooks: { telegramCard: this.store }, ...this.form.actions() }
  }
}
