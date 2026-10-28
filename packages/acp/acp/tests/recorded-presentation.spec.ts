/** Recorded POSIX tool presentation, without executing filesystem or shell operations. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCall } from '@agentclientprotocol/sdk'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { ShellExecutor, type ShellExecSpec, type ShellExecution } from '@deepseek-ai/dsh-shell'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as Bash from '@deepseek-ai/dsh-tool-bash'
import * as Fs from '@deepseek-ai/dsh-tool-fs'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AcpToolCursor } from '../src/tool-projection.ts'
import { eventUpdates } from '../src/updates.ts'
import { expect, it } from 'vitest'

const snapshots = fileURLToPath(new URL('../../../../snapshots/acp/', import.meta.url))
class PresentationShell extends ShellExecutor {
  override get sandboxMode() { return 'workspace-write' as const }
  resolve(): ShellExecSpec { throw new Error('presentation test must not resolve commands') }
  execute(): Promise<ShellExecution> { throw new Error('presentation test must not execute commands') }
}
class PresentationFs extends LocalFs {
  override get sandboxMode() { return 'workspace-write' as const }
}
interface Wire {
  method?: string
  params?: { sessionId: string; update?: SessionUpdate; toolCall?: ToolCall }
}

it('retains registered presentation in the POSIX recorded protocol examples', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx, '/snapshot')
  await ctx.plugin(SandboxPolicy)
  await ctx.plugin(PresentationShell)
  await ctx.plugin(PresentationFs)
  await ctx.plugin(ShellEnv)
  await ctx.plugin(Bash)
  await ctx.plugin(Fs)
  try {
    for (const directory of await readdir(snapshots)) {
      const root = join(snapshots, directory)
      const manifest = await readFile(join(root, 'snapshot.yml'), 'utf8').catch(() => '')
      if (!manifest.includes('platform: posix')) continue
      const files = await readdir(root)
      const generation = files.filter(name => /^session\.v\d+\.jsonl$/u.test(name))
        .sort((a, b) => Number(b.match(/v(\d+)/u)?.[1]) - Number(a.match(/v(\d+)/u)?.[1]))[0]
      if (generation === undefined) throw new Error(`No recorded session: ${directory}`)
      const records = (await readFile(join(root, generation), 'utf8')).replaceAll('{{cwd}}', '/snapshot').trim().split('\n')
      const session = Session.create(SessionId(`presentation-${directory}`))
      const cursor = new AcpToolCursor()
      const calls = new Map<string, SessionUpdate>()
      const results = new Map<string, SessionUpdate>()
      const titles: SessionUpdate[] = []
      // The synthetic cwd event initializes the output cursor without executing directory recovery.
      await eventUpdates(ctx, session, { type: 'working-directory/change', seq: SessionSeq(0), time: 0, data: { cwd: '/snapshot' } }, false, cursor)
      for (let index = 1; index < records.length; index++) {
        const event = { ...JSON.parse(records[index]!), seq: SessionSeq(index), time: 0 } as SessionEvent
        if (event.type !== 'tool/call' && event.type !== 'tool/result' && event.type !== 'session/title'
          && event.type !== 'step/end' && event.type !== 'working-directory/change') continue
        const updates = await eventUpdates(ctx, session, event, false, cursor)
        for (const update of updates) {
          if (update.sessionUpdate === 'tool_call') calls.set(update.toolCallId, update)
          if (update.sessionUpdate === 'tool_call_update') results.set(update.toolCallId, update)
          if (update.sessionUpdate === 'session_info_update') titles.push(update)
        }
      }
      const path = join(root, 'stdout.expected.jsonl')
      const expected = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Wire)
      let titleInserted = expected.some(row => row.params?.update?.sessionUpdate === 'session_info_update')
      const projected: Wire[] = []
      for (const row of expected) {
        const update = row.params?.update
        if (!titleInserted && update !== undefined && ['agent_thought_chunk', 'agent_message_chunk', 'tool_call'].includes(update.sessionUpdate)) {
          projected.push(...titles.map(title => ({ method: 'session/update', jsonrpc: '2.0', params: { sessionId: '{{sessionId}}', update: title } })))
          titleInserted = true
        }
        if (row.params !== undefined && update?.sessionUpdate === 'tool_call') row.params.update = calls.get(update.toolCallId) ?? update
        if (row.params !== undefined && update?.sessionUpdate === 'tool_call_update') row.params.update = results.get(update.toolCallId) ?? update
        if (row.params?.toolCall !== undefined) {
          const call = calls.get(row.params.toolCall.toolCallId)
          if (call?.sessionUpdate === 'tool_call') {
            const { sessionUpdate: _tag, ...subject } = call
            row.params.toolCall = subject
          }
        }
        projected.push(row)
      }
      const actualText = `${projected.map(row => JSON.stringify(row)).join('\n')}\n`.replaceAll('/snapshot', '{{cwd}}')
      expect(actualText, directory).toBe(await readFile(path, 'utf8'))
    }
  } finally { await ctx.fiber.dispose() }
})
