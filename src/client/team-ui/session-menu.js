import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, CheckIcon } from './icons.js'
import { stepMenuFocus, useLinger, useViewport, viewBottom } from './motion.js'
import { sessionLabel, sessionMeta, sessionTime, useBotSessionRows } from './bot-sessions.js'
import { CopyIdButton } from './copy-id.js'
import { t } from './i18n.js'

const MENU_WIDTH = 340
const MENU_EXIT_MS = 120

// A Bot's sessions from the chat's top bar, beside New session: a button that opens
// them by last activity with running sessions first. Each row shows the first thing the
// user asked, with marks for the open, running and waiting sessions. Picking one opens
// it; a session at work goes on in the background (parts.js selectPart). The
// button shows once the Bot has more than one session, with a dot while one other than
// the open one runs or waits.
//
// The list is drawn on <body> at the button, as the other anchored menus are: the top
// bar's glass is a layer of its own under the transcript. Unlike them it stays open while
// the transcript scrolls, which it does by itself while a session streams.
export function SessionMenu({ bot, roster, actions, useSessions }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(open ? place : null, MENU_EXIT_MS)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  const entries = useBotSessionRows(bot, roster, useSessions)
  const close = () => setOpen(false)
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16)
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    setPlace({ left, width, top: rect.bottom + 6, maxHeight: Math.max(160, viewBottom() - rect.bottom - 16), '--bt-origin': 'top right' })
  }, [open, tick])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => {
      if (stepMenuFocus(menu.current, event, button.current)) return
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
      button.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  if (entries.length < 2) return null
  const elsewhere = entries.filter(entry => !entry.current && (entry.running || entry.waiting)).length
  const label = elsewhere > 0 ? `${t('Switch session')} · ${t('{count} running in the background', { count: elsewhere })}` : t('Switch session')
  const pick = (entry) => {
    close()
    if (entry.current) return
    void Promise.resolve(actions.openPart(bot.id, entry.id)).catch(error => actions.reportError(error, 'open-session'))
  }
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-icon-btn bt-head-search bt-smenu-btn', 'aria-label': label, title: label,
      'aria-haspopup': 'menu', 'aria-expanded': open, 'data-open': open || undefined,
      onClick: () => setOpen(value => !value),
    }, h(ChatsIcon), elsewhere > 0 ? h('span', { className: 'bt-smenu-dot', 'aria-hidden': true }) : null),
    shownPlace ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-smenu-pop', role: 'menu', 'aria-label': t('Sessions'), style: shownPlace, 'data-leaving': leaving || undefined,
    },
    h('div', { className: 'bt-smenu-head', 'aria-hidden': true }, t('Sessions'), h('span', { className: 'bt-smenu-count' }, entries.length)),
    h('div', { className: 'bt-smenu-list' }, entries.map(entry => {
      const name = sessionLabel(entry, { bot, roster, rowTitle: entry.rowTitle })
      const meta = sessionMeta(entry, entry.at)
      // Each row's ID can be copied for troubleshooting; the copy button sits beside
      // the item, so picking and copying stay apart.
      return h('div', { key: entry.id, className: 'bt-smenu-row', role: 'none', 'data-current': entry.current || undefined },
        h('button', {
          type: 'button', role: 'menuitemradio', 'aria-checked': entry.current,
          className: 'bt-smenu-item', 'data-tone': meta.tone, 'data-current': entry.current || undefined,
          title: [name, sessionTime(entry.at)].filter(Boolean).join('\n'),
          onClick: () => pick(entry),
        },
        h('span', { className: 'bt-smenu-mark', 'aria-hidden': true }, entry.current ? h(CheckIcon) : null),
        h('span', { className: 'bt-smenu-title' }, name),
        h('span', { className: 'bt-smenu-meta' }, meta.text)),
        h(CopyIdButton, { id: entry.id }))
    }))), document.body) : null)
}

export const SESSION_MENU_CSS = `
.gb-chat-tools > .bt-smenu-btn[data-open]{background:var(--bt-hover);color:var(--bt-ink)}
.bt-smenu-dot{position:absolute;top:5px;right:5px;width:7px;height:7px;border-radius:50%;background:var(--bt-green);box-shadow:0 0 0 2px var(--bt-main);animation:bt-smenu-pulse 1.4s ease-in-out infinite}
.bt-smenu-head{display:flex;align-items:center;gap:6px;flex:none;padding:4px 8px 6px;font-size:12px;line-height:17px;font-weight:600;color:var(--bt-ink-2)}
.bt-smenu-count{font-weight:400;color:var(--bt-ink-3)}
.bt-smenu-list{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow-y:auto}
.bt-smenu-row{display:flex;align-items:center;gap:2px;padding-inline-end:4px;border-radius:6px}
.bt-smenu-row:hover,.bt-smenu-row[data-current]{background:var(--bt-hover)}
.bt-menu .bt-smenu-item{flex:1;min-width:0;gap:8px}
.bt-menu .bt-smenu-row>.bt-smenu-item:hover{background:none}
.bt-menu .bt-smenu-item[data-current]{font-weight:600}
.bt-menu .bt-smenu-row>.bt-copy-id{width:22px;height:22px;min-height:0;padding:0}
.bt-menu .bt-smenu-row>.bt-copy-id:hover{background:var(--bt-active)}
.bt-menu .bt-smenu-row>.bt-copy-id svg{width:14px;height:14px;margin:0}
.bt-smenu-mark{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-accent)}
.bt-smenu-mark svg{width:14px;height:14px}
.bt-smenu-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-smenu-meta{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:400;color:var(--bt-ink-3)}
.bt-smenu-item[data-tone=run] .bt-smenu-meta{color:var(--bt-ink-2)}
.bt-smenu-item[data-tone=run] .bt-smenu-meta::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--bt-green);animation:bt-smenu-pulse 1.4s ease-in-out infinite}
.bt-smenu-item[data-tone=wait] .bt-smenu-meta{color:var(--bt-warn)}
@keyframes bt-smenu-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.bt-smenu-dot,.bt-smenu-item[data-tone=run] .bt-smenu-meta::before{animation:none}}
`
