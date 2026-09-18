// Web e2e scenario: two independent browser clients observe one Session. Both
// point at the same running Host, both derive the conversation from the same
// persisted event log, and the second client replays it after a reload. Zero
// model calls: the Session is seeded cold through the real persistence API, and
// a stray stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// Another scenario's committed fixture, reused read-only: this spec needs any
// one cold Session whose rendered turn is stable, not new recorded content.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SEED_ID = 'two-client-session-web-e2e'
const MODE = webSnapshotMode()

describe('web e2e: two clients observe one Session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let pageA: Page
  let pageB: Page
  let tripwireA: ReturnType<typeof watchConsole>
  let tripwireB: ReturnType<typeof watchConsole>

  /** Expand the workspace group and open the seeded Session, awaiting its rendered turn. */
  async function openSeededSession(page: Page): Promise<void> {
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    pageA = await newEnglishPage(browser)
    pageB = await newEnglishPage(browser)
    tripwireA = watchConsole(pageA)
    tripwireB = watchConsole(pageB)
    // Two independent browser contexts: neither shares storage or a socket with
    // the other, so both are ordinary clients of the one Host.
    for (const page of [pageA, pageB]) {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    }
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('derives the same conversation twice and replays it after a reload', async () => {
    onTestFailed(() => saveFailureShot(pageA, 'web-e2e-two-client-a'))
    await openSeededSession(pageA)
    await openSeededSession(pageB)

    // Both clients render the same persisted turn from the one Session log.
    for (const page of [pageA, pageB]) {
      await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    }

    // The second client resumes the same conversation after a reload: its
    // history comes from the Host log, not from client-local retained state.
    const warningStart = tripwireB.warnings.length
    await pageB.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwireB, warningStart)
    await pageB.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => pageB.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    expect(tripwireA.pageErrors).toEqual([])
    expect(tripwireB.pageErrors).toEqual([])
  }, 120_000)
})
