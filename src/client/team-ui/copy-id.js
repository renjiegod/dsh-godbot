import { createElement as h, useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from './icons.js'
import { t } from './i18n.js'

const COPIED_MS = 1600

// The short form of a session ID that a row or panel shows: the first block of its
// UUID ("session-13bb0418-…" reads "13bb0418"), enough to find its folder under
// ~/.dsh/sessions. The copy is always the whole ID.
export function shortSessionId(id) {
  const value = String(id ?? '')
  const uuid = /^(?:session-)?([0-9a-f]{8})-[0-9a-f]{4}-/iu.exec(value)
  return uuid ? uuid[1] : value
}

// The clipboard API needs a secure context; a plain http address over the network
// has none, so a hidden field and the copy command stand in.
function writeText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  return new Promise((resolve, reject) => {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
    document.body.append(field)
    field.select()
    const copied = document.execCommand?.('copy') === true
    field.remove()
    if (copied) resolve()
    else reject(new Error('copy failed'))
  })
}

// A conversation's ID, for troubleshooting: the DSH session ID its history, logs and
// folder go by. The button copies it and says so for a moment; its tooltip shows the
// whole ID. It sits beside the row or title it belongs to, never inside another
// button, and a click on it does nothing else.
export function CopyIdButton({ id, className }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (typeof id !== 'string' || id === '') return null
  const copy = (event) => {
    event.stopPropagation()
    void writeText(id).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    }, () => {})
  }
  const label = copied ? t('Session ID copied') : t('Copy session ID')
  return h('button', {
    type: 'button', className: className ? `bt-copy-id ${className}` : 'bt-copy-id', 'data-copied': copied || undefined,
    'aria-label': label, title: `${label}\n${id}`, onClick: copy,
  }, copied ? h(CheckIcon, { key: 'done' }) : h(CopyIcon, { key: 'copy' }))
}

// The ID as text with its copy button, for a panel that shows one conversation.
export function SessionIdLine({ id, className }) {
  if (typeof id !== 'string' || id === '') return null
  return h('div', { className: className ? `bt-sid ${className}` : 'bt-sid' },
    h('span', { className: 'bt-sid-label' }, 'ID'),
    h('code', { className: 'bt-sid-value', title: id }, id),
    h(CopyIdButton, { id }))
}

export const COPY_ID_CSS = `
.bt-copy-id{flex:none;display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:none;color:var(--bt-ink-3);cursor:pointer;transition:color .12s,background-color .12s,opacity .12s}
.bt-copy-id svg{width:14px;height:14px;margin:0}
.bt-copy-id:hover{color:var(--bt-ink);background:var(--bt-hover)}
.bt-copy-id[data-copied]{color:var(--bt-green)}
.bt-copy-id:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-sid{display:flex;align-items:center;gap:6px;max-width:100%;min-width:0;margin-top:6px;font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-sid-label{flex:none;font-weight:600;letter-spacing:.02em}
.bt-sid-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--bt-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--bt-ink-2);user-select:all}
.gb-chat-title>.bt-copy-id{margin-inline:4px}
.gb-chat-title>.gb-chat-title-text+.bt-copy-id{margin-inline:-6px 4px}
.bt-drawer-sid{justify-content:center;margin-top:8px}
@media (hover:hover){
  .bt-smenu-row:not(:hover):not(:focus-within)>.bt-copy-id:not([data-copied]),
  .bt-agent-session-row:not(:hover):not(:focus-within)>.bt-copy-id:not([data-copied]){opacity:0}
}
`
