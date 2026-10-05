/** Draft-v2 stdio client for profile conformance and recorded-session replay. */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { materializeProfilePatch } from '@deepseek-ai/dsh-session-snapshot'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

/**
 * Launch an isolated dsh ACP profile and capture its v2 output.
 * @param cwd - caller-owned temporary workspace.
 * @param patches - ordered authored profile patches.
 * @param env - scenario-specific process environment.
 * @returns client, wire captures, and quiescent process cleanup.
 */
export function launchV2Profile(cwd: string, patches: string[], env: NodeJS.ProcessEnv = {}): {
  client: v2.ClientContext
  updates: v2.SessionUpdate[]
  stdout: () => string
  stderr: () => string
  close: () => Promise<void>
} {
  const materialized = patches.map((patch, index) => materializeProfilePatch(patch, cwd, 'acp', cwd, index))
  const launch = resolveExampleLaunch({
    srcBin: join(repoRoot, 'apps/cli/src/bin.ts'), libBin: join(repoRoot, 'apps/cli/lib/bin.js'),
    configArgs: ['--profile', 'acp', ...materialized.flatMap(patch => ['--patch', patch])],
    tsconfigPath: join(repoRoot, 'tsconfig.json'), sourceImport: 'tsx/esm',
    env: { ...env, DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents'), DSH_ACP_V2: '1', DSH_TELEMETRY_DISABLED: '1' },
  })
  const child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...launch.env }, stdio: 'pipe' })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => { resolve() })
    child.once('error', reject)
  })
  void closed.catch(() => {})
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const updates: v2.SessionUpdate[] = []
  const connection = v2.client().onNotification('session/update', ({ params }) => { updates.push(params.update) }).connect(v2.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  return {
    client: connection.agent, updates,
    stdout: () => stdout, stderr: () => stderr,
    async close() {
      child.stdin.end()
      const kill = setTimeout(() => child.kill(), 5_000)
      try { await closed; await connection.closed } finally { clearTimeout(kill) }
    },
  }
}
