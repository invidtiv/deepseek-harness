#!/usr/bin/env node
/** Keyless Loader driver: boot the smoke composition, then exit cleanly when the test drops its shutdown file. */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const NAME = 'telegram-test-driver'
const [configPath, shutdownArg] = process.argv.slice(2)
if (configPath === undefined || shutdownArg === undefined) {
  throw new Error(`${NAME}: expected <config-path> <shutdown-path>`)
}
const shutdownPath = resolve(shutdownArg)

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(shutdownPath)) {
        clearInterval(timer)
        resolve()
      }
    }, 100)
  })
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
