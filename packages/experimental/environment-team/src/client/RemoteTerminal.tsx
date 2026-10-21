/** A destination terminal emulator consumes ordered frames through explicit callbacks. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { EnvironmentTerminalFrame } from '../interaction-types.ts'
import '@xterm/xterm/css/xterm.css'
import css from './Environments.module.css'

/** Physical emulator inputs; no local terminal service is accessed. */
export interface RemoteTerminalProps {
  identity: string
  frame?: EnvironmentTerminalFrame | undefined
  revision: number
  label: string
  failureLabel: string
  disabled: boolean
  write: (data: string) => void
  rendered: (revision: number) => void
}
/** Render ordered destination terminal updates and return human input to that same connection.
 * @param props - frame, connection identity and scoped callbacks.
 * @returns an accessible xterm screen.
 */
export function RemoteTerminal(props: RemoteTerminalProps) {
  const element = useRef<HTMLDivElement>(null)
  const emulator = useRef<Terminal>()
  const current = useRef(props)
  const applied = useRef(0)
  const [ready, setReady] = useState(0)
  const [failed, setFailed] = useState(false)
  current.current = props
  useLayoutEffect(() => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- React attaches the element before layout effects run.
    const node = element.current!
    let disposed = false
    setFailed(false)
    let cleanup: (() => void) | undefined
    void import('./xterm-runtime.ts').then(({ Terminal: Emulator }) => {
      if (disposed) return
      const terminal = new Emulator({ minimumContrastRatio: 4.5, cursorBlink: true, scrollback: 0 })
      terminal.open(node)
      terminal.textarea?.setAttribute('aria-label', current.current.label)
      const style = getComputedStyle(node)
      terminal.options.theme = { background: style.backgroundColor, foreground: style.color, cursor: style.color }
      emulator.current = terminal; applied.current = 0
      const input = terminal.onData((data) => { if (!current.current.disabled) current.current.write(data) })
      cleanup = () => { input.dispose(); terminal.dispose(); emulator.current = undefined }
      setReady(value => value + 1)
    }).catch((_error: unknown) => { if (!disposed) setFailed(true) })
    return () => { disposed = true; cleanup?.() }
  }, [props.identity])
  useLayoutEffect(() => {
    const terminal = emulator.current
    const { frame, revision } = props
    if (!terminal || !frame || revision <= applied.current) return
    applied.current = revision
    const rendered = (): void => { if (emulator.current === terminal) current.current.rendered(revision) }
    if (frame.frame.type === 'state') {
      terminal.resize(frame.frame.info.cols, frame.frame.info.rows); rendered(); return
    }
    if (frame.frame.type === 'snapshot') {
      terminal.reset(); terminal.resize(frame.frame.info.cols, frame.frame.info.rows)
      terminal.write(frame.frame.screen, rendered)
    } else terminal.write(frame.frame.data, rendered)
  }, [props.frame, props.revision, props.identity, props.rendered, ready])
  return <><div className={css.terminal} ref={element} />{failed && <p role="alert">{props.failureLabel}</p>}</>
}
