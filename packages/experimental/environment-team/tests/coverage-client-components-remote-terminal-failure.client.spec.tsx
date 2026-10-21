// @vitest-environment jsdom
/** A terminal runtime that cannot load reports a failure only while the terminal is still shown. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteTerminal } from '../src/client/RemoteTerminal.tsx'

const runtime = vi.hoisted(() => ({ requested: false }))
vi.mock('../src/client/xterm-runtime.ts', () => { runtime.requested = true; throw new Error('runtime unavailable') })
afterEach(cleanup)
const props = { identity: 'one', revision: 0, label: 'Input', failureLabel: 'Failed', disabled: false, write: vi.fn(), rendered: vi.fn() }

it('stays silent when the runtime fails after the terminal closed', async () => {
  const view = render(<RemoteTerminal {...props} />)
  view.unmount()
  await vi.waitFor(() => { expect(runtime.requested).toBe(true) })
  await new Promise<void>((done) => { setTimeout(done, 0) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the failure label when the emulator runtime cannot load', async () => {
  render(<RemoteTerminal {...props} />)
  expect((await screen.findByRole('alert')).textContent).toBe('Failed')
})
