/** Optional conformance against the actual generic ACP runtime in a local T3 Code checkout. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { materializeProfilePatch } from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'

const t3Root = process.env.DSH_T3_CODE_ROOT
const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

it.skipIf(t3Root === undefined)('T3 generic ACP runtime launches dsh and discovers models and commands, runs tools, goal permissions, pause/resume, cancellation and history loading', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-t3-acp-'))
  try {
    const patch = materializeProfilePatch(fileURLToPath(new URL('./fixtures/control-surface/cordis.yml', import.meta.url)), cwd, 'acp', cwd, 0)
    const launch = resolveExampleLaunch({
      srcBin: join(repoRoot, 'apps/cli/src/bin.ts'), libBin: join(repoRoot, 'apps/cli/lib/bin.js'),
      configArgs: ['--profile', 'acp', '--patch', patch], tsconfigPath: join(repoRoot, 'tsconfig.json'), sourceImport: 'tsx/esm',
      env: { DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents'), DSH_CONFORMANCE_PERSISTENCE_ROOT: join(cwd, '.sessions'), DSH_TELEMETRY_DISABLED: '1' },
    })
    const optionsFile = join(cwd, 'client.json')
    await writeFile(optionsFile, JSON.stringify({
      spawn: { command: launch.command, args: launch.args, cwd, env: launch.env, extendEnv: true },
      cwd, clientInfo: { name: 't3-interop', version: '1' }, authMethodId: 'none',
      mcpServers: [{ name: 'fixture', command: process.execPath, args: [join(repoRoot, 'packages/mcp/mcp-client/tests/fixture-server.ts')], env: [] }],
    }))
    const probe = fileURLToPath(new URL('./fixtures/t3-client.mjs', import.meta.url))
    const result = await promisify(execFile)(process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), probe, t3Root!, optionsFile], { timeout: 35_000 })
    expect(JSON.parse(result.stdout)).toMatchObject({
      protocolVersion: 2, models: true, commands: true, goals: true, permissions: 2, loaded: true,
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 45_000)
