import { createElement as h, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermStyle from '@xterm/xterm/css/xterm.css'
import style from './terminal-panel.css'
import { Icon } from './chat-ui.js'
import { attachTerminal } from './terminal-connection.js'
import { attachTerminalHighlight, attachTerminalLinks } from './terminal-highlight.js'
import { highlightColors, terminalThemes } from './terminal-theme.js'
import { NativeConversationView, readNativeScreen } from './native-conversation-panel.js'

const agents = { claude: 'Claude Code', 'local-claude-code': 'Claude Code', codex: 'Codex', 'local-codex-cli': 'Codex',
  antigravity: 'Antigravity', 'local-antigravity': 'Antigravity', agy: 'Antigravity', dsh: 'dsh' }
const states = { opening: '正在连接', recovering: '恢复屏幕', live: '已连接', error: '连接中断', exited: '已退出', ending: '正在交还', returned: '已交还' }
const highlightKey = 'godbot.terminal.highlight'
const linkHint = (/Mac|iPhone|iPad/u.test(navigator.platform) ? '⌘' : 'Ctrl') + ' + 点击打开链接'

function readHighlight() {
  try { return localStorage.getItem(highlightKey) !== 'off' } catch { return true }
}
function saveHighlight(on) {
  try { localStorage.setItem(highlightKey, on ? 'on' : 'off') } catch { /* Storage is optional. */ }
}
function openLink(url) {
  if (/^https?:\/\//iu.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
}

function TerminalSession({ client, target, close, mode, onModeChange }) {
  const view = useRef(null), wire = useRef(null), termRef = useRef(null), highlighter = useRef(null)
  const [attempt, setAttempt] = useState({ number: 0 })
  const [state, setState] = useState({ phase: 'opening' })
  const [confirm, setConfirm] = useState(false)
  const [screen, setScreen] = useState('')
  const [highlight, setHighlight] = useState(readHighlight)
  const conversation = mode === 'conversation'
  const highlighting = useRef(highlight && !conversation)
  highlighting.current = highlight && !conversation
  const { memberId, botId, sessionId, agent, label } = target
  useLayoutEffect(() => {
    const node = view.current
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const scheme = () => {
      const value = getComputedStyle(node).colorScheme
      return value === 'light' || value === 'dark' ? value : media.matches ? 'dark' : 'light'
    }
    let currentTheme = scheme()
    const panel = node.closest('.gb-terminal-panel')
    panel.dataset.scheme = currentTheme
    let viewport
    const hint = on => { if (viewport) viewport.title = on ? linkHint : '' }
    const terminal = new Terminal({
      cursorBlink: true, cursorStyle: 'block', fontSize: 13, lineHeight: 1.14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: terminalThemes[currentTheme], minimumContrastRatio: 4.5, scrollback: 3000, macOptionIsMeta: true,
      // Decorations tint unstyled output without rewriting the CLI's bytes.
      allowProposedApi: true,
      // OSC 8 hyperlinks from the CLI follow the same Cmd/Ctrl-click rule as detected URLs.
      linkHandler: {
        activate: (event, uri) => { if (event.metaKey || event.ctrlKey) openLink(uri) },
        hover: () => hint(true), leave: () => hint(false),
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    // xterm measures each new glyph against the DOM. Isolate its stylesheet
    // so these synchronous measurements don't re-evaluate the shell's rules.
    const shadow = node.shadowRoot ?? node.attachShadow({ mode: 'open' })
    const sheet = document.createElement('style')
    sheet.textContent = xtermStyle + '\n.xterm { height: 100%; width: 100%; padding: 0 }'
    viewport = document.createElement('div')
    viewport.style.height = '100%'
    shadow.replaceChildren(sheet, viewport)
    terminal.open(viewport)
    const highlights = attachTerminalHighlight(terminal, { colors: highlightColors[currentTheme], enabled: highlighting.current })
    const links = attachTerminalLinks(terminal, { open: openLink, hint })
    highlighter.current = highlights
    const updateTheme = () => {
      const next = scheme()
      if (next === currentTheme) return
      currentTheme = next
      panel.dataset.scheme = next
      terminal.options.theme = terminalThemes[next]
      highlights.setColors(highlightColors[next])
    }
    const themeObserver = new MutationObserver(updateTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-theme-source', 'data-theme'] })
    media.addEventListener('change', updateTheme)
    // The shell owns global shortcuts outside the terminal. Inside, xterm
    // processes Escape, Tab, arrow keys, composition and Ctrl+C first.
    const contain = event => event.stopPropagation()
    node.addEventListener('keydown', contain)
    node.addEventListener('keyup', contain)
    const resize = () => {
      if (!node.clientWidth || !node.clientHeight) return
      const size = fit.proposeDimensions()
      if (size) terminal.resize(Math.min(size.cols, 500), Math.min(size.rows, 250))
    }
    resize()
    let frame
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resize)
    })
    observer.observe(node)
    termRef.current = terminal
    setState({ phase: 'opening' })
    const connection = attachTerminal({
      client, terminal, refit: resize,
      target: { ...(memberId ? { memberId } : { botId }), ...(sessionId ? { sessionId } : {}), agent },
      options: attempt.options,
      status: patch => setState(previous => ({ ...previous, ...patch })),
    })
    wire.current = connection
    return () => {
      wire.current = null
      termRef.current = null
      highlighter.current = null
      connection.detach()
      highlights.dispose()
      links.dispose()
      observer.disconnect()
      themeObserver.disconnect()
      media.removeEventListener('change', updateTheme)
      cancelAnimationFrame(frame)
      node.removeEventListener('keydown', contain)
      node.removeEventListener('keyup', contain)
      terminal.dispose()
      shadow.replaceChildren()
    }
  }, [client, memberId, botId, sessionId, agent, attempt])

  useLayoutEffect(() => {
    const terminal = termRef.current
    if (!conversation) {
      terminal.focus()
      return
    }
    let frame
    const update = () => { frame = undefined; setScreen(readNativeScreen(terminal)) }
    const schedule = () => { frame ??= requestAnimationFrame(update) }
    update()
    const parsed = terminal.onWriteParsed(schedule)
    const resized = terminal.onResize(schedule)
    return () => {
      cancelAnimationFrame(frame)
      parsed.dispose()
      resized.dispose()
    }
  }, [conversation, attempt])

  // The hidden terminal behind the conversation view needs no highlighting.
  useLayoutEffect(() => {
    highlighter.current?.setEnabled(highlight && !conversation)
  }, [highlight, conversation])

  const toggleHighlight = () => {
    saveHighlight(!highlight)
    setHighlight(!highlight)
  }
  const retry = restart => {
    setConfirm(false)
    setAttempt(previous => ({ number: previous.number + 1, options: restart && state.info
      ? { restart: true, terminalId: state.info.terminalId } : undefined }))
  }
  const giveBack = async () => {
    setConfirm(false)
    if (await wire.current?.end()) close()
  }
  const canEnd = !!state.info && state.phase !== 'ending' && state.phase !== 'returned'
  const activeAgent = agents[state.info?.agent] ?? state.info?.agent ?? agents[agent] ?? agent
  const note = state.info?.stale ? '该会话使用先前的 Bot 设置。交还聊天后可按当前设置重新打开。' : null
  const exit = state.exit
  const output = state.phase === 'error' ? state.error : state.phase === 'exited'
    ? exit?.error || (exit?.signal ? '退出信号 ' + exit.signal : Number.isInteger(exit?.exitCode) ? '退出码 ' + exit.exitCode : '终端进程已退出') : null
  return h('aside', { className: 'gb-terminal-panel', 'aria-label': (label || activeAgent) + ' 原生 Agent', 'data-phase': state.phase, 'data-mode': mode },
    h('style', null, style),
    h('header', { className: 'gb-term-head' },
      h('span', { className: 'gb-term-mark' }, h(Icon, { name: 'terminal', size: 19 })),
      h('div', { className: 'gb-term-heading' }, h('strong', null, label || activeAgent),
        h('small', null, label && label !== activeAgent ? activeAgent + ' · 当前 Bot 私聊' : '当前 Bot 私聊')),
      h('div', { className: 'gb-term-actions' },
        !conversation && h('button', { className: 'gb-term-icon-button', type: 'button', 'aria-pressed': highlight,
          'aria-label': '输出高亮', title: highlight ? '关闭输出高亮' : '开启输出高亮：为路径、链接、数字、代码和错误着色',
          onClick: toggleHighlight }, h(Icon, { name: 'sparkle', size: 16 })),
        canEnd && h('button', { type: 'button', title: '结束终端并将控制权交还聊天',
          onClick: () => state.phase === 'exited' ? void giveBack() : setConfirm(true) }, '交还聊天'),
        h('button', { className: 'gb-term-collapse', type: 'button', onClick: close,
          title: '收起面板，保持运行', 'aria-label': '收起原生 Agent' }, h(Icon, { name: 'close', size: 16 })))),
    onModeChange && h('div', { className: 'gb-term-modes', role: 'group', 'aria-label': '原生 Agent 模式' },
      [['terminal', '原生终端'], ['conversation', '原生对话']].map(([value, name]) =>
        h('button', { key: value, type: 'button', 'aria-pressed': mode === value, onClick: () => onModeChange(value) }, name))),
    confirm && h('div', { className: 'gb-term-confirm', role: 'group', 'aria-label': '交还聊天控制' },
      h('span', null, '运行中的任务会停止。若在终端另开或切换了会话，聊天仍接回原会话。'),
      h('button', { type: 'button', onClick: () => { setConfirm(false); termRef.current?.focus() } }, '继续使用'),
      h('button', { className: 'gb-term-primary', type: 'button', onClick: giveBack }, '结束并交还')),
    note && h('div', { className: 'gb-term-note', role: 'status' }, note),
    h('div', { className: 'gb-term-body' },
      h('div', { ref: view, className: 'gb-term-screen', inert: conversation ? true : undefined, 'aria-hidden': conversation || undefined, 'aria-label': 'CLI 输入和输出' }),
      onModeChange && h('div', { className: 'gb-term-conversation', hidden: !conversation },
        h(NativeConversationView, {
          key: state.info?.terminalId ?? 'opening', client, target, terminalId: state.info?.terminalId,
          active: conversation, phase: state.phase, screen,
          submit: text => wire.current?.submit(text), sendKey: data => wire.current?.sendKey(data),
          onShowTerminal: () => onModeChange('terminal'),
        }))),
    h('footer', { className: 'gb-term-foot' },
      h('span', { className: 'gb-term-state', role: 'status' }, h('i', { 'data-live': state.phase === 'live' || undefined }), states[state.phase]),
      output ? h('span', { className: 'gb-term-output', role: state.phase === 'error' ? 'alert' : undefined }, output)
        : h('span', { className: 'gb-term-path', title: state.info?.cwd }, state.info?.cwd),
      state.phase === 'error' && h('button', { type: 'button', onClick: () => retry(false) }, '重新连接'),
      state.phase === 'exited' && h('button', { type: 'button', onClick: () => retry(true) }, '重开终端')))
}

/** Unmounting hides this view and leaves its Host PTY running. */
export function TerminalPanel({ client, target, close, mode = 'terminal', onModeChange }) {
  if (!target) return null
  const key = JSON.stringify([target.botId, target.memberId, target.sessionId, target.agent])
  return h(TerminalSession, { key, client, target, close, mode, onModeChange })
}
