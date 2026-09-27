// @vitest-environment jsdom
/** Physical terminal frames are acknowledged only after the emulator consumes their bytes. */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteTerminal } from '../src/client/RemoteTerminal.tsx'
import type { EnvironmentTerminalFrame } from '../src/interaction-types.ts'

const emulator = vi.hoisted(() => ({
  write: vi.fn(), resize: vi.fn(), reset: vi.fn(), dispose: vi.fn(), inputDispose: vi.fn(),
  input: undefined as ((text: string) => void) | undefined,
}))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options = {}; textarea = document.createElement('textarea')
  open() {}
  resize = emulator.resize
  reset = emulator.reset
  write = emulator.write
  dispose = emulator.dispose
  onData(callback: (text: string) => void) { emulator.input = callback; return { dispose: emulator.inputDispose } }
} }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const base = {
  environmentId: brandString<EnvironmentTerminalFrame['environmentId']>('remote'),
  workspaceId: brandString<EnvironmentTerminalFrame['workspaceId']>('workspace'),
  sessionId: brandString<EnvironmentTerminalFrame['sessionId']>('session'),
  terminalId: brandString<EnvironmentTerminalFrame['terminalId']>('terminal'),
}

it('applies snapshot and ordered output, routes keyboard bytes and drops acknowledgments from a replaced emulator', async () => {
  const rendered = vi.fn(), write = vi.fn()
  const frame: EnvironmentTerminalFrame = { ...base, frame: { type: 'snapshot', sequence: 0, screen: 'prompt', info: {
    id: base.terminalId, title: 'Shell', shell: { path: 'sh', name: 'sh', args: [] }, cwd: '/project', cols: 90, rows: 30, state: 'running', exitCode: null,
  } } }
  const props = { identity: 'one', frame, revision: 1, label: 'Input', failureLabel: 'Failed', disabled: false, write, rendered }
  const view = render(<RemoteTerminal {...props} />)
  await waitFor(() => { expect(emulator.reset).toHaveBeenCalledOnce() })
  expect(emulator.reset).toHaveBeenCalledOnce(); expect(emulator.resize).toHaveBeenCalledWith(90, 30)
  expect(rendered).not.toHaveBeenCalled()
  const first = emulator.write.mock.calls[0]?.[1] as () => void
  first(); expect(rendered).toHaveBeenCalledWith(1)
  emulator.input?.('ls\r'); expect(write).toHaveBeenCalledWith('ls\r')
  view.rerender(<RemoteTerminal {...props} disabled frame={{ ...base, frame: { type: 'output', sequence: 1, data: 'files' } }} revision={2} />)
  emulator.input?.('ignored'); expect(write).toHaveBeenCalledOnce()
  const stale = emulator.write.mock.calls[1]?.[1] as () => void
  view.rerender(<RemoteTerminal {...props} identity="two" />)
  await waitFor(() => { expect(emulator.reset).toHaveBeenCalledTimes(2) })
  stale(); expect(rendered).toHaveBeenCalledOnce()
  expect(emulator.dispose).toHaveBeenCalledOnce()
  view.unmount(); expect(emulator.dispose).toHaveBeenCalledTimes(2)
})
