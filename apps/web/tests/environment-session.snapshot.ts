/** Live management snapshots over a shipped Web profile and an unchanged recorded Session. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import type EnvironmentTeamSettings from '@deepseek-ai/dsh-experimental-environment-team/management'
import type { EnvironmentSessionFrame } from '@deepseek-ai/dsh-experimental-environment-team/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, webSnapshotMode,
} from './scaffold.ts'

const fixture = fileURLToPath(new URL('../../../snapshots/web/feedback-command/session.v3.jsonl', import.meta.url))
const expected = fileURLToPath(new URL('../../../snapshots/web/environment-session/stream.expected.md', import.meta.url))
const plugin = fileURLToPath(new URL('../../../packages/experimental/environment-team/cordis.patch.yml', import.meta.url))
const manifest = fileURLToPath(new URL('../../../packages/experimental/environment-team/package.json', import.meta.url))
const overlay = fileURLToPath(new URL('./environment-session.overlay.yml', import.meta.url))

it.skipIf(webSnapshotMode() === 'record')('streams remote-session text before settlement and catches up from the recorded Web Session', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: 'read-only', paceMs: 30,
    extraOverlayPath: [plugin, overlay], extraInstallAnchors: [manifest],
  })
  const abort = new AbortController()
  const streams: AsyncIterator<EnvironmentSessionFrame>[] = []
  onTestFinished(async () => {
    abort.abort()
    try { await Promise.all(streams.map(async (stream) => { await stream.return?.() })) } finally { await scaffold.close() }
  })
  const management = scaffold.ctx.get('environmentTeamSettings') as EnvironmentTeamSettings | undefined
  if (!management) throw new Error('The published environment management plugin did not activate')
  const { environmentId } = await management.read()
  const registered = await management.workspace(environmentId, { action: 'register', alias: 'project', relativePath: '' })
  if (registered.kind !== 'registered') throw new Error('The destination did not register its workspace')
  const { workspaceId } = registered.workspace
  const sessionId = SessionId('recorded-environment-session')
  await management.session(environmentId, { action: 'create', workspaceId, sessionId }, abort.signal)
  const iterator = management.sessionFollow(environmentId, { workspaceId, sessionId }, abort.signal)[Symbol.asyncIterator]()
  streams.push(iterator)
  const opening = await iterator.next()
  if (opening.done) throw new Error('The destination omitted its opening snapshot')
  expect(opening.value.messages).toEqual([])
  const prompt = fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]!
  const liveTexts: string[] = []
  const readUntilSettled = (async () => {
    while (true) {
      const frame = await iterator.next()
      if (frame.done) throw new Error('The session stream closed before its recorded answer')
      expect(frame.value.environmentId).toBe(environmentId)
      expect(frame.value.workspaceId).toBe(workspaceId)
      expect(frame.value.sessionId).toBe(sessionId)
      if (frame.value.live?.text) {
        expect(frame.value.messages.some(message => message.role === 'assistant')).toBe(false)
        liveTexts.push(frame.value.live.text)
      }
      if (frame.value.live === undefined && frame.value.messages.some(message => message.role === 'assistant')) return frame.value
    }
  })()
  const settled = scaffold.whenTurnSettled()
  const response = await scaffold.hostFetch('/api/session/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'recorded-prompt', method: 'session/prompt', payload: { args: { request: {
      sessionId, requestId: 'recorded-prompt', mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: 'Europe/London',
    } } } }),
  })
  expect(await response.json()).toMatchObject({ result: { ok: true, value: { accepted: true } } })
  const final = await readUntilSettled
  await settled
  expect(liveTexts.length).toBeGreaterThan(0)
  expect(liveTexts.every(text => 'LIGHTHOUSE'.startsWith(text))).toBe(true)
  expect(liveTexts.at(-1)).toBe('LIGHTHOUSE')
  await iterator.return?.()
  const resumed = management.sessionFollow(environmentId, { workspaceId, sessionId }, abort.signal)[Symbol.asyncIterator]()
  streams.push(resumed)
  const catchup = await resumed.next()
  if (catchup.done) throw new Error('The destination omitted its reconnect snapshot')
  expect(catchup.value.messages).toEqual(final.messages)
  expect(catchup.value.live).toBeUndefined()
  await compareOrRefreshGolden(expected, [
    `live assistant: ${liveTexts.at(-1)}`,
    ...final.messages.map(message => `${message.role}: ${message.text}`),
    'reconnected: same committed messages; no live duplicate',
  ].join('\n'), webSnapshotMode())
  // The borrowed fixture also owns this command's persisted lifecycle.
  const feedback = await scaffold.hostFetch('/api/commands/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'recorded-feedback', method: 'commands/execute', payload: { args: {
      agentId: sessionId, line: '/feedback the diff view is unreadable', submittedAttachments: [],
    } } }),
  })
  expect(await feedback.json()).toMatchObject({ result: { ok: true } })
})
