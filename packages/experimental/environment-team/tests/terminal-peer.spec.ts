/** Paired HTTP terminal streams preserve ordered output and destination identity. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EnvironmentSessionInteractions } from '../src/session-interactions.ts'
import { PeerTransport } from '../src/transport.ts'
import { TERMINAL_FOLLOW_PATH } from '../src/peer-stream.ts'
import type { EnvironmentTerminalFrame, EnvironmentTerminalFollowRequest } from '../src/interaction-types.ts'
import { pairedSessionHosts } from './session-peer-host.ts'

const closes: (() => Promise<void>)[] = []
const aborts: AbortController[] = []
afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort()
  vi.restoreAllMocks()
  for (const close of closes.splice(0).reverse()) await close()
})

it('delivers a recovery screen and every output frame, releasing only the viewer on disconnect', async () => {
  const { caller, destination, token } = await pairedSessionHosts((close) => { closes.push(close) })
  const request: EnvironmentTerminalFollowRequest = { workspaceId: destination.workspace.id, sessionId: SessionId(randomUUID()),
    terminalId: brandString<EnvironmentTerminalFollowRequest['terminalId']>('terminal'),
    attachmentId: brandString<EnvironmentTerminalFollowRequest['attachmentId']>('viewer') }
  const base = { environmentId: destination.id, workspaceId: request.workspaceId,
    sessionId: request.sessionId, terminalId: request.terminalId }
  const snapshot: EnvironmentTerminalFrame = { ...base, frame: { type: 'snapshot', sequence: 0, screen: 'screen', info: {
    id: request.terminalId, title: 'Shell', cwd: destination.cwd, cols: 80, rows: 24,
    shell: { path: '/fixture/shell', args: [], name: 'Fixture shell' }, state: 'running', exitCode: null,
  }, writable: true } }
  const frames: EnvironmentTerminalFrame[] = [snapshot,
    { ...base, frame: { type: 'output', sequence: 1, data: 'first' } },
    { ...base, frame: { type: 'output', sequence: 2, data: 'second' } }]
  const stopped = Promise.withResolvers<undefined>()
  const source = vi.spyOn(EnvironmentSessionInteractions.prototype, 'followTerminal').mockImplementation(async function* (_peer, _request, signal) {
    try {
      yield* frames
      if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } finally { stopped.resolve(undefined) }
  })
  const transport = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  const abort = new AbortController()
  aborts.push(abort)
  const iterator = transport.terminalFollow(destination.id, request, abort.signal)[Symbol.asyncIterator]()
  for (const frame of frames) expect((await iterator.next()).value).toEqual(frame)
  expect(source).toHaveBeenCalledWith(caller.id, request, expect.any(AbortSignal))
  abort.abort()
  await iterator.return?.()
  await stopped.promise
  const denied = await fetch(destination.url + TERMINAL_FOLLOW_PATH, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin: caller.url, 'content-type': 'application/json' },
    body: JSON.stringify({ environmentId: destination.id, request }) })
  expect(denied.status).toBe(401)
  await denied.body?.cancel()
  expect(source).toHaveBeenCalledOnce()
})

it('rejects output for another terminal instead of displaying it in the selected viewer', async () => {
  const { caller, destination } = await pairedSessionHosts((close) => { closes.push(close) })
  const request: EnvironmentTerminalFollowRequest = { workspaceId: destination.workspace.id, sessionId: SessionId(randomUUID()),
    terminalId: brandString<EnvironmentTerminalFollowRequest['terminalId']>('terminal'),
    attachmentId: brandString<EnvironmentTerminalFollowRequest['attachmentId']>('viewer') }
  vi.spyOn(EnvironmentSessionInteractions.prototype, 'followTerminal').mockImplementation(async function* () {
    yield { environmentId: destination.id, workspaceId: request.workspaceId, sessionId: request.sessionId,
      terminalId: brandString<EnvironmentTerminalFrame['terminalId']>('another-terminal'), frame: { type: 'output', sequence: 1, data: 'foreign output' } }
  })
  const transport = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  const abort = new AbortController()
  aborts.push(abort)
  const iterator = transport.terminalFollow(destination.id, request, abort.signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
})

it('requires a matching recovery baseline and contiguous output before accepting terminal updates', async () => {
  const { caller, destination } = await pairedSessionHosts((close) => { closes.push(close) })
  const request: EnvironmentTerminalFollowRequest = { workspaceId: destination.workspace.id, sessionId: SessionId(randomUUID()),
    terminalId: brandString<EnvironmentTerminalFollowRequest['terminalId']>('terminal'),
    attachmentId: brandString<EnvironmentTerminalFollowRequest['attachmentId']>('viewer') }
  const base = { environmentId: destination.id, workspaceId: request.workspaceId,
    sessionId: request.sessionId, terminalId: request.terminalId }
  const snapshot: EnvironmentTerminalFrame = { ...base, frame: { type: 'snapshot', sequence: 4, screen: 'screen', info: {
    id: request.terminalId, title: 'Shell', cwd: destination.cwd, cols: 80, rows: 24,
    shell: { path: '/fixture/shell', args: [], name: 'Fixture shell' }, state: 'running', exitCode: null,
  }, writable: true } }
  const output: EnvironmentTerminalFrame = { ...base, frame: { type: 'output', sequence: 6, data: 'gap' } }
  const source = vi.spyOn(EnvironmentSessionInteractions.prototype, 'followTerminal')
  const transport = new PeerTransport(caller.id, caller.config, caller.ctx.credentials)
  for (const frames of [[output], [snapshot, output], [snapshot, snapshot]]) {
    source.mockImplementationOnce(async function* () { yield* frames })
    const abort = new AbortController()
    aborts.push(abort)
    const iterator = transport.terminalFollow(destination.id, request, abort.signal)[Symbol.asyncIterator]()
    if (frames.length > 1) expect((await iterator.next()).value).toEqual(snapshot)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'environment/session-protocol' })
  }
})
