// @vitest-environment jsdom
/** Destination terminal state frames, repeated revisions and early teardown. */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteTerminal, type RemoteTerminalProps } from '../src/client/RemoteTerminal.tsx'
import type { EnvironmentTerminalFrame } from '../src/interaction-types.ts'

const emulator = vi.hoisted(() => ({
  constructed: 0, loaded: false, write: vi.fn(), resize: vi.fn(), reset: vi.fn(), dispose: vi.fn(), inputDispose: vi.fn(),
  textarea: true,
}))
vi.mock('@xterm/xterm', () => { emulator.loaded = true; return { Terminal: class {
  options = {}; textarea = emulator.textarea ? document.createElement('textarea') : undefined
  constructor() { emulator.constructed += 1 }
  open() {}
  resize = emulator.resize
  reset = emulator.reset
  write = emulator.write
  dispose = emulator.dispose
  onData() { return { dispose: emulator.inputDispose } }
} } })
afterEach(() => { cleanup(); vi.clearAllMocks(); emulator.constructed = 0; emulator.textarea = true })
const base = {
  environmentId: brandString<EnvironmentTerminalFrame['environmentId']>('remote'),
  workspaceId: brandString<EnvironmentTerminalFrame['workspaceId']>('workspace'),
  sessionId: brandString<EnvironmentTerminalFrame['sessionId']>('session'),
  terminalId: brandString<EnvironmentTerminalFrame['terminalId']>('terminal'),
}
const info = { id: base.terminalId, title: 'Shell', shell: { path: 'sh', name: 'sh', args: [] }, cwd: '/project', cols: 120, rows: 40, state: 'running' as const, exitCode: null }
const props = (overrides: Partial<RemoteTerminalProps>): RemoteTerminalProps =>
  ({ identity: 'one', revision: 0, label: 'Input', failureLabel: 'Failed', disabled: false, write: vi.fn(), rendered: vi.fn(), ...overrides })

it('resizes on a state frame and acknowledges it without writing bytes', async () => {
  const rendered = vi.fn()
  const state: EnvironmentTerminalFrame = { ...base, frame: { type: 'state', info } }
  const view = render(<RemoteTerminal {...props({ rendered })} />)
  await waitFor(() => { expect(emulator.constructed).toBe(1) })
  view.rerender(<RemoteTerminal {...props({ rendered, frame: state, revision: 1 })} />)
  expect(emulator.resize).toHaveBeenCalledExactlyOnceWith(120, 40)
  expect(rendered).toHaveBeenCalledExactlyOnceWith(1)
  expect(emulator.write).not.toHaveBeenCalled()
  expect(emulator.reset).not.toHaveBeenCalled()
})

it('applies each revision once and waits for the emulator before rendering a frame', async () => {
  const rendered = vi.fn()
  const output: EnvironmentTerminalFrame = { ...base, frame: { type: 'output', sequence: 1, data: 'files' } }
  const view = render(<RemoteTerminal {...props({ rendered, frame: output, revision: 1 })} />)
  await waitFor(() => { expect(emulator.write).toHaveBeenCalledOnce() })
  expect(emulator.write.mock.calls[0]?.[0]).toBe('files')
  view.rerender(<RemoteTerminal {...props({ rendered, frame: output, revision: 1, label: 'Changed' })} />)
  expect(emulator.write).toHaveBeenCalledOnce()
})

it('opens an emulator without an input textarea', async () => {
  emulator.textarea = false
  render(<RemoteTerminal {...props({})} />)
  await waitFor(() => { expect(emulator.constructed).toBe(1) })
})

it('does not create an emulator when the terminal closes before the runtime loads', async () => {
  const view = render(<RemoteTerminal {...props({})} />)
  view.unmount()
  await vi.waitFor(() => { expect(emulator.loaded).toBe(true) })
  await new Promise<void>((done) => { setTimeout(done, 0) })
  expect(emulator.constructed).toBe(0)
})
