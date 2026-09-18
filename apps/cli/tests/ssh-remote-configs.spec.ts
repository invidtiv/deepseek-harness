/**
 * The SSH remote-execution example overlay stays config-only and must keep
 * addressing the shipped bundle rows: a patch that matched nothing would leave
 * a local provider enabled beside its remote counterpart, and two providers may
 * not register the same `ctx.fs`, `ctx.subprocess` or `ctx.sandbox`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'

const root = resolve(import.meta.dirname, '../../..')
const overlay = resolve(root, 'apps/cli/config/examples/ssh-remote/cordis.yml')
const basePatch = resolve(root, 'packages/bundle/base/cordis.patch.yml')

type EntryList = Parameters<typeof applyEntryPatches>[0]

/** Compose the real base row list with the overlay, collecting skipped-patch warnings. */
function compose(): { rows: EntryList; warnings: string[] } {
  const baseRows = loadOverlayPatches('ssh-remote-config-test', basePatch)
    .flatMap(layer => layer.insert ?? [])
  const warnings: string[] = []
  const rows = applyEntryPatches(
    baseRows,
    loadOverlayPatches('ssh-remote-config-test', overlay),
    message => warnings.push(message),
  )
  return { rows, warnings }
}

/** The composed row carrying one entry id. */
const rowOf = (rows: EntryList, id: string) => rows.find(row => row.id === id)

const localProviders = [
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
]

describe('SSH remote-execution example overlay', () => {
  it('disables every local execution provider it replaces', () => {
    const { rows, warnings } = compose()

    expect(warnings).toEqual([])
    for (const id of ['fs-sandbox', 'subprocess', 'sandbox']) {
      expect(rowOf(rows, id)?.disabled).toBe(true)
    }
    expect(rows.filter(row => row.disabled !== true && localProviders.includes(row.name))).toEqual([])
  })

  it('mounts the named-environment connection with its remote providers', () => {
    const { rows } = compose()

    expect(rowOf(rows, 'ssh-environments')?.name).toBe('@deepseek-ai/dsh-ssh-environments')
    expect(rowOf(rows, 'ssh')?.name).toBe('@deepseek-ai/dsh-ssh')
    expect(rowOf(rows, 'fs-ssh')?.name).toBe('@deepseek-ai/dsh-fs-ssh')
    expect(rowOf(rows, 'subprocess-ssh')?.name).toBe('@deepseek-ai/dsh-subprocess-ssh')
    expect(rowOf(rows, 'sandbox-ssh')?.name).toBe('@deepseek-ai/dsh-sandbox-ssh')

    const config = rowOf(rows, 'ssh')?.config as Record<string, unknown> | undefined
    for (const field of ['environment', 'node', 'helper', 'helperHash', 'workspace']) {
      expect(Object.hasOwn(config ?? {}, field)).toBe(true)
    }
  })

  it('points the default file-effect root at the remote workspace', () => {
    const { rows } = compose()
    const config = rowOf(rows, 'sandbox-policy')?.config as { mode?: unknown; workspaceRoot?: unknown } | undefined

    expect(JSON.stringify(config?.workspaceRoot)).toContain('DSH_SSH_WORKSPACE')
    expect(config?.mode).toBeDefined()
  })

  it('declares no secret in the overlay source', () => {
    const source = readFileSync(overlay, 'utf8')

    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
    expect(source).not.toMatch(/secret|password|passphrase/i)
    expect(source).not.toContain('DEEPSEEK_API_KEY')
  })
})
