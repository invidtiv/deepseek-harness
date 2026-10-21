/** Prompt size limits and catalog ordering for destination Sessions. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { EnvironmentSessions } from '../src/session-service.ts'
import { sessionHost } from './session-host.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close() })
const signal = new AbortController().signal

async function fixture() {
  const host = await sessionHost()
  closers.push(host.close)
  return { ...host, executor: new EnvironmentSessions(host.ctx, host.id, host.config) }
}

it('refuses a prompt whose request exceeds the configured byte limit', async () => {
  const host = await fixture()
  const workspaceId = host.workspace.id
  const sessionId = SessionId(randomUUID())
  await host.executor.run(host.id, { action: 'create', workspaceId, sessionId }, signal)
  host.config.maxBytes = 100
  await expect(host.executor.run(host.id, { action: 'prompt', workspaceId, sessionId, requestId: brandString<SessionRequestId>(randomUUID()), text: 'x'.repeat(200) }, signal)).rejects.toThrow('prompt request byte limit reached')
})

it('lists Sessions with equal update times by descending identity regardless of catalog order', async () => {
  const host = await fixture()
  const workspaceId = host.workspace.id
  const ids = ['session-a', 'session-b', 'session-c'].map(SessionId)
  for (const sessionId of ids) await host.executor.run(host.id, { action: 'create', workspaceId, sessionId }, signal)
  const catalog = await host.controller.list({}, signal)
  const items = catalog.items.map(item => ({ ...item, updatedAt: 1 })).sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  const list = vi.spyOn(host.controller, 'list')
  for (const order of [items, [...items].reverse()]) {
    list.mockResolvedValueOnce({ ...catalog, items: order })
    expect(await host.executor.run(host.id, { action: 'list', workspaceId }, signal)).toMatchObject({ sessions: [{ sessionId: 'session-c' }, { sessionId: 'session-b' }, { sessionId: 'session-a' }] })
  }
})
