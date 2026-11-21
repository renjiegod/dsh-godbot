import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { Icon } from './chat-ui.js'
import { screenSince } from './native-conversation-screen.js'
import style from './native-conversation.css'

export { readNativeScreen } from './native-conversation-screen.js'

const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
const keys = [
  ['↑', '上移选择', '\x1b[A'], ['↓', '下移选择', '\x1b[B'],
  ['Enter', '按下 Enter', '\r'], ['Esc', '按下 Esc', '\x1b'], ['Ctrl+C', '中断当前操作', '\x03'],
]
const messageOf = error => error?.message || String(error)

function BoundHistory({ client, terminalId, active }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active || !terminalId || result) return
    let current = true
    setError('')
    client.dispatch({ action: 'terminal.history', terminalId }).then(value => {
      if (current) setResult(value)
    }).catch(cause => { if (current) setError(messageOf(cause)) })
    return () => { current = false }
  }, [client, terminalId, active, result, attempt])
  if (!terminalId) return null
  if (error) return h('div', { className: 'gb-native-history-error' }, '读取绑定会话记录失败 · ' + error,
    h('button', { type: 'button', onClick: () => setAttempt(i => i + 1) }, '重试'))
  if (!result?.messages?.length) return null
  return h('details', { className: 'gb-native-history', open: true },
    h('summary', null, (result.source === 'native' ? '绑定的原生会话记录' : '绑定的 Bot 聊天记录') +
      '（' + result.messages.length + '）'),
    h('div', { className: 'gb-native-messages' }, result.messages.map(message =>
      h('article', { className: 'gb-native-message', 'data-role': message.role, key: message.id },
        h('small', null, message.role === 'user' ? '你' : 'Agent'),
        message.role === 'user' ? h('p', null, message.text) :
          h(MarkdownText, { text: message.text, labels: markdownLabels, variant: 'compact' })))))
}

function finishOutput(log, screen) {
  const output = screenSince(log.before, screen, log.input)
  return output ? [...log.items, { role: 'cli', text: output }] : log.items
}

export function NativeConversationView({ client, target, terminalId, active = true, phase, screen = '', submit, sendKey }) {
  const [log, setLog] = useState({ items: [], before: '', input: '' })
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [writing, setWriting] = useState(false)
  const pending = useRef(false), mounted = useRef(false)
  const scroll = useRef(null), content = useRef(null), following = useRef(true)
  const field = useRef(null), lastScreen = useRef(screen)
  const live = phase === 'live' && active
  const output = screenSince(log.before, screen, log.input)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useLayoutEffect(() => {
    if (active) lastScreen.current = screen
  }, [active, screen])
  useLayoutEffect(() => {
    if (!active) {
      // After use of the terminal keyboard, any subsequent CLI output belongs
      // to that terminal as a whole, not necessarily to the last chat prompt.
      const previous = lastScreen.current
      setLog(current => ({ items: finishOutput(current, previous).slice(-80), before: previous, input: '' }))
    }
  }, [active])
  useLayoutEffect(() => {
    if (live) field.current?.focus({ preventScroll: true })
  }, [live])
  useLayoutEffect(() => {
    if (!active || !scroll.current) return
    const el = scroll.current
    const follow = () => { if (following.current) el.scrollTop = el.scrollHeight }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(content.current)
    return () => observer.disconnect()
  }, [active])

  async function write(action, done) {
    if (!live || pending.current) return
    pending.current = true
    setWriting(true)
    setError('')
    try {
      const accepted = await action()
      if (mounted.current) {
        if (accepted !== true) setError('原生终端未确认接收输入，请检查连接状态。')
        else done?.()
      }
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause))
    } finally {
      pending.current = false
      if (mounted.current) setWriting(false)
    }
  }
  function send(event) {
    event.preventDefault()
    if (!draft.trim()) return
    const text = draft
    const before = screen
    void write(() => submit(text), () => {
      following.current = true
      setLog(current => ({ items: [...finishOutput(current, before), { role: 'user', text }].slice(-80), before, input: text }))
      setDraft(current => current === text ? '' : current)
      field.current?.focus({ preventScroll: true })
    })
  }
  const agent = target.label || 'Agent'
  return h('section', { className: 'gb-native-conversation', 'aria-label': '原生对话' },
    h('style', null, style),
    h('div', { className: 'gb-native-scroller', ref: scroll, onScroll: ({ currentTarget: el }) => {
      following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48
    } },
      h('div', { ref: content },
        h(BoundHistory, { key: terminalId || '', client, terminalId, active }),
        h('div', { className: 'gb-native-messages', 'aria-label': '本次原生对话' },
          log.items.map((item, i) => h('article', { key: i, className: 'gb-native-message', 'data-role': item.role },
            h('small', null, item.role === 'user' ? '你' : agent + ' · CLI 输出'),
            h(item.role === 'user' ? 'p' : 'pre', null, item.text))),
          output && h('article', { className: 'gb-native-message', 'data-role': 'cli', 'data-native-output': true },
            h('small', null, agent + ' · CLI 输出'), h('pre', null, output))))),
    h('form', { className: 'gb-native-compose', onSubmit: send },
      error && h('div', { role: 'alert', className: 'gb-native-input-error' }, error),
      h('textarea', { ref: field, rows: 2, 'aria-label': '原生对话输入', placeholder: '向原生 Agent 发送消息或 / 命令',
        value: draft, disabled: !live, onChange: e => setDraft(e.target.value), onKeyDown: e => {
          e.stopPropagation()
          if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey ||
            e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
          send(e)
        } }),
      h('div', { className: 'gb-native-compose-actions' },
        h('details', { className: 'gb-native-keys' },
          h('summary', null, '终端按键'),
          h('div', { className: 'gb-native-key-list' }, keys.map(([label, title, bytes]) =>
            h('button', { type: 'button', key: label, disabled: !live || writing, 'aria-label': title, title,
              onClick: () => write(() => sendKey(bytes)) }, label)))),
        h('button', { type: 'submit', className: 'gb-native-submit', 'aria-label': '发送到原生 Agent',
          disabled: !live || writing || !draft.trim() }, h(Icon, { name: 'send', size: 16 }), '发送'))))
}
