/**
 * The SSH environments card's staged form over the `ssh-environments`
 * settings namespace.
 *
 * The namespace holds one map, so the card stages the whole set of rows and
 * writes it in one save. A row keeps the stored entry it came from, so fields
 * this card does not edit (keys, bastions, host-key policy, timeouts) survive
 * the write instead of being dropped by the editor.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/**
 * Namespace of the SSH environment registry. Spelled here rather than
 * imported: a client package must not depend on a Host package, and the
 * registry spells the same value.
 */
export const SSH_ENVIRONMENTS_NS = 'ssh-environments'

/** The one section field this card edits. */
const FIELD = 'environments'

/** One configured environment as the registry schema resolves it. */
export interface SshEnvironmentSetting {
  /** OpenSSH destination: a config-file alias, a host name, or an address. */
  host: string
  /** Display label; absent falls back to the environment id. */
  label?: string
  /** Connection options this card does not edit; a save passes them through unchanged. */
  readonly [option: string]: unknown
}

/** The `ssh-environments` section as this card reads and writes it. */
export interface SshEnvironmentsSettings {
  /** Configured environments by stable id. */
  environments?: Record<string, SshEnvironmentSetting>
}

/** One environment as the card renders it. */
export interface SshEnvironmentRow {
  /** Stable edit key: the configured id, or a minted key for a row not yet named. */
  readonly key: string
  /** Identifier draft. */
  readonly id: string
  /** Whether the identifier draft is not an acceptable, unused id. */
  readonly idInvalid: boolean
  /** OpenSSH destination draft. */
  readonly host: string
  /** Whether the destination draft is not an acceptable OpenSSH destination. */
  readonly hostInvalid: boolean
}

/** What the SSH environments card renders. */
export interface SshEnvironmentsCardState extends CardShell {
  /** Every environment row, in configured order followed by new rows. */
  readonly rows: readonly SshEnvironmentRow[]
}

/** The registration-side face the card's slot entry injects. */
export interface SshEnvironmentsCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSshEnvironmentsCard. */
    sshEnvironmentsCard: SnapshotStore<SshEnvironmentsCardState>
  }
  /** Stage a new, empty environment row. */
  add: () => void
  /** Drop one row by edit key. */
  remove: (key: string) => void
  /** Stage one row's identifier. */
  editId: (key: string, text: string) => void
  /** Stage one row's OpenSSH destination. */
  editHost: (key: string, text: string) => void
  /** Write every staged row. */
  save: () => void
  /** Drop every staged row. */
  discard: () => void
}

/** A stable environment id: one path-free, dot-separated token. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
/** An OpenSSH destination: an alias, host name, or address OpenSSH accepts. */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/

/** One row's staged text plus the stored entry its unedited fields come from. */
interface RowDraft {
  readonly key: string
  readonly id: string
  readonly host: string
  readonly stored: SshEnvironmentSetting
}

/** Bridges the `ssh-environments` scope onto the card's staged rows. */
export class SshEnvironmentsCardController {
  private drafts: RowDraft[] | undefined
  private minted = 0
  private saving = false
  private failed = false
  private readonly store: SnapshotStore<SshEnvironmentsCardState>

  /** @param scope - the bound settings scope for the `ssh-environments` namespace. */
  constructor(private readonly scope: SettingsScope<SshEnvironmentsSettings>) {
    this.store = createSnapshotStore(this.projection())
    scope.subscribe(() => { this.publish() })
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its row actions.
   */
  inject(): SshEnvironmentsCardFace {
    return {
      hooks: { sshEnvironmentsCard: this.store },
      add: () => { this.staged().push(this.newRow()); this.stage() },
      remove: (key) => {
        this.drafts = this.staged().filter(row => row.key !== key)
        this.stage()
      },
      editId: (key, text) => { this.edit(key, row => ({ ...row, id: text })) },
      editHost: (key, text) => { this.edit(key, row => ({ ...row, host: text })) },
      save: () => { void this.save() },
      discard: () => {
        if (this.drafts === undefined && !this.failed) return
        this.drafts = undefined
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged row as the namespace's complete environment map, then
   * read back whether the Host holds it. The Host is the authority on which
   * entries it accepts, so an unlanded save keeps its drafts.
   * @returns settlement after the write and the read-back.
   */
  async save(): Promise<void> {
    const rows = this.rows()
    if (this.drafts === undefined || this.saving || rows.some(row => this.invalid(row, rows))) return
    this.saving = true
    this.failed = false
    this.publish()
    const environments: Record<string, SshEnvironmentSetting> = {}
    for (const row of rows) environments[row.id.trim()] = { ...row.stored, host: row.host.trim() }
    await this.scope.set(FIELD, environments)
    const landed = this.landed(rows)
    if (landed) this.drafts = undefined
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private projection(): SshEnvironmentsCardState {
    const rows = this.rows()
    return {
      ...this.shell(rows),
      rows: rows.map(row => ({
        key: row.key,
        id: row.id,
        idInvalid: this.identifierInvalid(row, rows),
        host: row.host,
        hostInvalid: !HOST_PATTERN.test(row.host.trim()),
      })),
    }
  }

  private shell(rows: readonly RowDraft[]): CardShell {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.drafts !== undefined && !this.sameOrder(this.drafts, this.configuredRows()),
      invalid: rows.some(row => this.invalid(row, rows)),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** Every staged row, materialized from the configured section on first edit. */
  private staged(): RowDraft[] {
    this.drafts ??= this.configuredRows()
    return this.drafts
  }

  /** Every rendered row: the drafts while any edit stands, the section otherwise. */
  private rows(): RowDraft[] {
    return this.drafts ?? this.configuredRows()
  }

  private configuredRows(): RowDraft[] {
    return Object.entries(this.environments()).map(([id, entry]) => ({
      key: id, id, host: entry.host, stored: entry,
    }))
  }

  private environments(): Record<string, SshEnvironmentSetting> {
    return this.scope.getSnapshot().value?.environments ?? {}
  }

  /** An identifier the registry can key: well formed and used by this row alone. */
  private identifierInvalid(row: RowDraft, rows: readonly RowDraft[]): boolean {
    const id = row.id.trim()
    if (!ID_PATTERN.test(id)) return true
    return rows.filter(candidate => candidate.id.trim() === id).length > 1
  }

  private invalid(row: RowDraft, rows: readonly RowDraft[]): boolean {
    return this.identifierInvalid(row, rows) || !HOST_PATTERN.test(row.host.trim())
  }

  /** Whether the saved section carries exactly these rows. */
  private landed(rows: readonly RowDraft[]): boolean {
    const configured = this.environments()
    return Object.keys(configured).length === rows.length
      && rows.every(row => configured[row.id.trim()]?.host === row.host.trim())
  }

  /** Whether two row sets carry the same rows in the same order. */
  private sameOrder(left: readonly RowDraft[], right: readonly RowDraft[]): boolean {
    return left.length === right.length
      && left.every((row, index) => {
        const other = right[index] as RowDraft
        return row.key === other.key && row.id === other.id && row.host === other.host
      })
  }

  /** Replace one staged row, leaving every other row as it is. */
  private edit(key: string, change: (row: RowDraft) => RowDraft): void {
    this.drafts = this.staged().map(row => row.key === key ? change(row) : row)
    this.stage()
  }

  private newRow(): RowDraft {
    return { key: `new-${this.minted++}`, id: '', host: '', stored: { host: '' } }
  }

  private stage(): void {
    this.failed = false
    this.publish()
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
