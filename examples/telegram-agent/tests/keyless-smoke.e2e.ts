import { describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { MockTelegramServer } from './fixtures/mock-telegram-server.mjs'

const binScript = fileURLToPath(new URL('./fixtures/telegram-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/smoke.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('telegram-agent keyless smoke', () => {
  it('boots the real Loader tree and answers a topic message through the real Bot API client', async () => {
    const server = await MockTelegramServer.start()
    let shutdownPath = ''
    try {
      const run = runLoaderSmoke({
        label: 'telegram-agent',
        tempDirPrefix: 'telegram-agent-smoke-',
        binScript,
        libBinScript: binScript,
        configPath,
        tsconfigPath,
        processTimeoutMs: 60_000,
        env: {
          DSH_TELEGRAM_API_BASE: server.url,
          DSH_TELEGRAM_ALLOWED_CHATS: '1001',
          DSH_TELEGRAM_ALLOWED_USERS: '7001',
          DSH_TELEGRAM_PROVIDER: 'cli-mock',
          DSH_TELEGRAM_MODEL: 'cli-mock',
          TELEGRAM_BOT_TOKEN: 'test-token',
        },
        prepare: (cwd) => {
          shutdownPath = join(cwd, '.shutdown')
        },
        binArgs: [configPath, '.shutdown'],
      })
      await server.waitForFirstPoll()
      server.pushUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 1001 },
          from: { id: 7001, is_bot: false, first_name: 'smoker' },
          text: 'prove the telegram round trip',
        },
      })
      await vi.waitFor(
        () => {
          expect(server.texts()).toContain('TELEGRAM_SMOKE_ANSWER')
        },
        { timeout: 45_000, interval: 100 },
      )
      await writeFile(shutdownPath, 'shutdown')
      const { stderr } = await run
      expect(stderr).toBe('')
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
