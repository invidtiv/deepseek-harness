// Web e2e scenario: the Add-workspace flow over a named SSH environment. The
// deployment composes an in-memory remote world (fixture), so the picker offers
// the environment, the in-app dialog lists that server's folders, and the
// adopted directory registers a workspace in that world instead of the host's.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./fixtures/ssh-world.patch.yml', import.meta.url))
const FIXTURE_ANCHOR = fileURLToPath(new URL('./fixtures/plugins/fixture-ssh-world/package.json', import.meta.url))

describe('web e2e: workspace picker over a named SSH environment', () => {
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

  it('offers the environment, browses its folders in-app, and adopts one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ssh-world-picker'))
    await page.getByRole('button', { name: 'Add workspace' }).click()

    // The composed world offers the environment beside the plain host entry,
    // even when it is the deployment's only one.
    const entry = page.getByRole('menuitem', { name: 'Add workspace on BSD dev…' })
    await entry.waitFor({ timeout: 10_000 })
    expect(await page.getByRole('menuitem', { name: 'Add workspace…', exact: true }).count()).toBe(1)
    await entry.click()

    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })
    // The dialog opens at the environment's workspace and lists its children.
    await expect.poll(() => dialog.getByText('project', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThan(0)
    expect(await dialog.getByText('notes.txt', { exact: true }).count()).toBe(0)

    // Adopt the remote directory: the workspace registers in that world.
    await dialog.getByText('project', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Open' }).click()
    await expect.poll(() => page.getByText('project', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
