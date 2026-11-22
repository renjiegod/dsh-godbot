import { createElement as h, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermStyle from '@xterm/xterm/css/xterm.css'
import { m } from './machine-copy.js'

/** Terminal bytes stay out of React state and storage. Each component owns one host PTY. */
export function MachineTerminal({ rpc, onEnd, onExit }) {
  const element = useRef(null)
  const terminal = useRef(null)
  const [scrolledBack, setScrolledBack] = useState(false)
  useLayoutEffect(() => {
    const node = element.current
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, monospace',
      fontSize: 14,
      scrollback: 1500,
      theme: { background: '#171c1a', foreground: '#ecf1e8', cursor: '#f5be7f' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(node)
    terminal.current = term
    const scrolled = term.onScroll(() => {
      const buffer = term.buffer.active
      setScrolledBack(buffer.viewportY < buffer.baseY)
    })
    let stopped = false,
      sequence = 0,
      ready = false,
      sending = Promise.resolve(),
      cursor = 0
    const stopWith = (error) => {
      if (!stopped) {
        stopped = true
        onEnd(error.message || String(error))
      }
    }
    const geometry = () => ({
      cols: Math.max(2, Math.min(400, term.cols)),
      rows: Math.max(1, Math.min(180, term.rows)),
    })
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (ready && !stopped) void rpc('terminal.resize', geometry()).catch(stopWith)
    })
    observer.observe(node)
    const chars = term.onData((text) => {
      const bytes = new TextEncoder().encode(text)
      for (let at = 0; at < bytes.length; at += 8192) {
        const data = btoa(String.fromCharCode(...bytes.subarray(at, at + 8192)))
        sending = sending
          .then(async () => {
            if (!ready || stopped) return
            const seq = ++sequence
            const input = { seq, data }
            let answer
            try {
              answer = await rpc('terminal.write', input)
            } catch (error) {
              // A live host might have applied the input before its acknowledgement was lost.
              if (stopped || !/RPC_TIMEOUT|timed out/i.test(error.message)) throw error
              answer = await rpc('terminal.write', input)
            }
            if (answer.ack !== seq) throw new Error('Terminal input acknowledgement mismatch')
          })
          .catch(stopWith)
      }
    })
    async function read() {
      fit.fit()
      await rpc('terminal.open', geometry())
      if (stopped) return
      ready = true
      term.focus()
      while (!stopped) {
        const result = await rpc('terminal.read', { cursor, waitMs: 1200 })
        if (stopped) return
        if (result.truncated) term.writeln('\r\n[' + m('Earlier output was truncated') + ']')
        if (result.data) {
          const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
          await new Promise((resolve) => term.write(bytes, resolve))
        }
        cursor = result.cursor
        if (result.exited || Number.isInteger(result.exitCode)) {
          stopped = true
          term.options.disableStdin = true
          term.options.cursorBlink = false
          onExit(result.exitCode)
          return
        }
      }
    }
    void read().catch(stopWith)
    return () => {
      stopped = true
      observer.disconnect()
      chars.dispose()
      scrolled.dispose()
      terminal.current = null
      term.dispose()
    }
  }, [rpc, onEnd, onExit])
  return h(
    'div',
    { className: 'gb-machine-term', role: 'region', 'aria-label': m('Remote terminal') },
    h('style', null, xtermStyle),
    h('div', { ref: element, className: 'gb-machine-term-box' }),
    scrolledBack &&
      h(
        'button',
        {
          type: 'button',
          className: 'gb-machine-jump',
          onClick: () => {
            terminal.current?.scrollToBottom()
            terminal.current?.focus()
          },
        },
        m('Jump to latest'),
      ),
  )
}
