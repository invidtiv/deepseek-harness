// Web e2e scenario: the Workspace Directory dialog over a remote execution
// world. The composed filesystem is a fixture that is not the harness host, so
// every row the dialog lists comes from that world and no host path can appear.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./fixtures/remote-fs.patch.yml', import.meta.url))
const FIXTURE_ANCHOR = fileURLToPath(new URL('./fixtures/plugins/fixture-remote-fs/package.json', import.meta.url))

describe('web e2e: workspace picker over a remote execution world', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: [FIXTURE_ANCHOR] })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('lists the remote world root and never a host directory', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-remote-workspace-picker'))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })

    // The dialog opens at the world root ('/'), because a provider that cannot
    // read host files has no host home to map, and lists that world's children.
    await expect.poll(() => dialog.getByText('remote-project', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThan(0)
    // The picker offers directories only: a file in the same world is not a row.
    expect(await dialog.getByText('notes.txt', { exact: true }).count()).toBe(0)
    expect(await dialog.getByText(scaffold.workspaceCwd, { exact: false }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
