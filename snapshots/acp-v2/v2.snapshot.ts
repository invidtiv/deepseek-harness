/** Replay the recorded cancellation turn through the v2 public protocol. */
import { mkdtemp, readFile, readdir, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  fixtureContext, normalizeSessionSnapshots, normalizeStdout, latestPersistedSessionPaths, sessionFixtureFiles,
} from '@deepseek-ai/dsh-session-snapshot'
import { launchV2Profile } from '../../apps/cli/tests/profiles/acp/tests/v2-harness.ts'

const corpus = fileURLToPath(new URL('../acp/', import.meta.url))

it('v2 acceptance, user echo and cancellation preserve the recorded Session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-v2-snapshot-'))
  const sessionsRoot = join(cwd, '.sessions')
  const fixture = join(corpus, 'cancel', sessionFixtureFiles(await readdir(join(corpus, 'cancel')))[0]!.name)
  const launched = launchV2Profile(cwd, [join(corpus, 'escalation-approved/cordis.yml'), join(corpus, 'escalation-approved/cordis.snapshot.yml')], {
    DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: fixture,
    DSH_SNAPSHOT_OVERRIDE: join(corpus, 'cancel/replay.override.json'),
    DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
    DSH_SNAPSHOT_SPILL_ROOT: join(cwd, '.spill'),
  })
  try {
    const { client, updates } = launched
    await client.request('initialize', { protocolVersion: 2, info: { name: 'snapshot', version: '1' }, capabilities: {} })
    const { sessionId } = await client.request('session/new', { cwd })
    const accepted = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Start a long task; this turn will be cancelled mid-stream.' }] })
    expect(accepted.messageId).toBeTruthy()
    await expect.poll(async () => access(join(cwd, '.dsh-snapshot-stream-ready')).then(() => true, () => false), { timeout: 20_000 }).toBe(true)
    await client.notify('session/cancel', { sessionId })
    await expect.poll(() => updates.at(-1), { timeout: 20_000 }).toMatchObject({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' })
    await client.request('session/close', { sessionId })
    const logs = latestPersistedSessionPaths((await readdir(sessionsRoot, { recursive: true })).map(path => join(sessionsRoot, path)))
    const persisted = await readFile(logs[0]!, 'utf8')
    const expected = await readFile(fixture, 'utf8')
    const ctx = { cwd, sessionIds: [sessionId] }
    expect(normalizeSessionSnapshots([persisted], ctx, { nativeWriterOutput: true })).toEqual(normalizeSessionSnapshots([expected], fixtureContext(expected), { nativeWriterOutput: true }))
    const output = normalizeStdout(launched.stdout(), ctx)
    const golden = fileURLToPath(new URL('./cancel/stdout.expected.jsonl', import.meta.url))
    if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(golden, output)
    await expect(output).toMatchFileSnapshot(golden)
  } catch (error: unknown) {
    throw new Error(`v2 snapshot failed; stderr: ${launched.stderr()}`, { cause: error })
  } finally {
    try { await launched.close() } finally { await rm(cwd, { recursive: true, force: true }) }
  }
})
