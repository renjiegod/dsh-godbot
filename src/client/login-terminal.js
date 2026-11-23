// The pseudo-terminal of a local agent CLI's sign-in (the host's sign-in.js), shown
// in the sign-in panel. It reuses the Bot terminal's connection: the same reads,
// writes and resizes, addressed by the sign-in instead of a Bot's chat.
import { createElement as h, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermStyle from '@xterm/xterm/css/xterm.css'
import { attachTerminal } from './terminal-connection.js'
import { attachTerminalLinks } from './terminal-highlight.js'
import { terminalThemes } from './terminal-theme.js'

function openLink(url) {
  if (/^https?:\/\//iu.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
}

// The terminal calls of attachTerminal, on the sign-in endpoints.
export function loginTerminalClient(call, loginId, { cols, rows }) {
  return {
    terminalOpen: async () => ({ terminalId: loginId, cols, rows, cursor: 0, reused: false, exit: null }),
    terminalRead: ({ cursor, waitMs }, signal) => call('local-agent-login-term-read', { loginId, cursor, waitMs }, signal, { quiet: true }),
    terminalWrite: ({ data }) => call('local-agent-login-term-write', { loginId, data }),
    terminalResize: ({ cols: width, rows: height }) => call('local-agent-login-term-resize', { loginId, cols: width, rows: height }),
    terminalClose: () => call('local-agent-login-cancel', { loginId }),
  }
}

export function LoginTerminal({ call, loginId, size, onStatus, label }) {
  const view = useRef(null)
  useLayoutEffect(() => {
    const node = view.current
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const terminal = new Terminal({
      cursorBlink: true, fontSize: 12, lineHeight: 1.12, scrollback: 1000, macOptionIsMeta: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: terminalThemes[dark ? 'dark' : 'light'], minimumContrastRatio: 4.5, allowProposedApi: true,
      linkHandler: { activate: (_event, uri) => openLink(uri) },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    const shadow = node.shadowRoot ?? node.attachShadow({ mode: 'open' })
    const sheet = document.createElement('style')
    sheet.textContent = xtermStyle + '\n.xterm { height: 100%; width: 100%; padding: 0 }'
    const viewport = document.createElement('div')
    viewport.style.height = '100%'
    shadow.replaceChildren(sheet, viewport)
    terminal.open(viewport)
    // A link in a sign-in screen is the point of it: a plain click opens it.
    const links = attachTerminalLinks(terminal, { open: openLink, hint: () => {}, plainClick: true })
    const contain = event => event.stopPropagation()
    node.addEventListener('keydown', contain)
    node.addEventListener('keyup', contain)
    const resize = () => {
      if (!node.clientWidth || !node.clientHeight) return
      const proposed = fit.proposeDimensions()
      if (proposed) terminal.resize(Math.min(Math.max(proposed.cols, 20), 300), Math.min(Math.max(proposed.rows, 5), 120))
    }
    resize()
    let frame
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resize)
    })
    observer.observe(node)
    const connection = attachTerminal({
      client: loginTerminalClient(call, loginId, size), terminal, refit: resize, target: {},
      status: patch => onStatus?.(patch),
    })
    terminal.focus()
    return () => {
      connection.detach()
      links.dispose()
      observer.disconnect()
      cancelAnimationFrame(frame)
      node.removeEventListener('keydown', contain)
      node.removeEventListener('keyup', contain)
      terminal.dispose()
      shadow.replaceChildren()
    }
  }, [call, loginId])
  return h('div', { ref: view, className: 'bt-signin-term', role: 'group', 'aria-label': label })
}
