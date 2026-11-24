import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { Elapsed, Shimmer, workPhrase } from './cells.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { workState } from './member-status.js'
import { memberWorkTarget, otherWorkers, workAt } from './member-work-model.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// One member's work in a group, in the panel beside the group's conversation: the turn
// its group Session runs now, or the turn a line of the group came from, shown with the
// same process view as a Bot's own chat. The member's group Session is no chat the user
// opens, and its own chat is another conversation, so this is where that work shows.
// The group's capsule, its "started on it" line, a reply's tool count, the details'
// member row and the capsule in the Bot's own chat open it.

const EMPTY = '{"entry":null,"entries":[],"asking":false}'
const STICK_PX = 48

export function MemberWorkView({ roomId, at, roster, actions, useWork }) {
  const room = roster.roomsById[roomId]
  const botId = at?.botId
  const bot = botId === undefined ? undefined : roster.byId[botId]
  const close = () => actions.closeOverlay()
  useEscape(close)
  // Picked as text, so the view redraws only when what it shows changes.
  const raw = useWork?.(work => (room === undefined ? EMPTY : JSON.stringify({
    entry: (work.rooms?.[room.id] ?? []).find(item => item.botId === botId) ?? null,
    entries: work.rooms?.[room.id] ?? [],
    asking: (work.approvals ?? []).some(item => item.botId === botId && item.roomId === room.id),
  }))) ?? EMPTY
  const { entry, entries, asking } = useMemo(() => JSON.parse(raw), [raw])
  const target = memberWorkTarget(at, entry)
  const others = otherWorkers(entries, botId)
  const [stopping, setStopping] = useState(false)

  // A running turn follows its newest call while the view stays at the bottom; scrolling
  // up to read an earlier call holds it there.
  const body = useRef(null)
  const content = useRef(null)
  const stick = useRef(target?.running === true)
  useEffect(() => {
    stick.current = target?.running === true
    const node = body.current
    if (!node || !content.current || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(() => { if (stick.current) node.scrollTop = node.scrollHeight })
    observer.observe(content.current)
    return () => observer.disconnect()
  }, [target?.sessionId, target?.turn, target?.running])
  const onScroll = () => {
    const node = body.current
    if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX
  }

  const head = h('div', { key: 'head', className: 'bt-subhead bt-work-head' },
    room ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), title: t('Back to details'), onClick: () => actions.showDetails(room.sessionId ?? room.id) }, h(ChevronLeftIcon)) : null,
    h('span', { className: 'bt-subhead-title' }, t('Work process')),
    h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon)))
  if (room === undefined || bot === undefined) {
    return [head, h('div', { key: 'body', className: 'bt-drawer-body' }, h('div', { className: 'bt-muted' }, t('This member is no longer in the group.')))]
  }

  const stop = () => {
    setStopping(true)
    void Promise.resolve(actions.stopMemberWork(room.id, bot.id))
      .catch(error => actions.reportError(error, 'stop'))
      .finally(() => setStopping(false))
  }
  const running = target?.running === true
  const count = running ? entry?.count : at?.tools
  const status = asking && running
    ? h('span', { className: 'bt-work-status bt-mw-ask' }, t('Waiting for your approval'),
      h('button', { type: 'button', className: 'bt-work-link', onClick: () => actions.showDetails(room.sessionId ?? room.id) }, t('Answer in details')))
    : running
      ? h('span', { className: 'bt-work-status' },
        h('span', { className: 'bt-work-what' }, h(Shimmer, null, `${workPhrase(entry)}…`)),
        count > 0 ? h('span', { className: 'bt-work-meta' }, `· ${t('{count} tool calls', { count })}`) : null,
        typeof entry?.since === 'number' ? h(Elapsed, { at: entry.since, className: 'bt-work-meta' }) : null)
      : target
        ? h('span', { className: 'bt-work-status' }, t('This turn has ended'),
          count > 0 ? h('span', { className: 'bt-work-meta' }, `· ${t('{count} tool calls', { count })}`) : null)
        : h('span', { className: 'bt-work-status' }, t('{name} is not working in this group now', { name: bot.name }))

  const who = h('div', { key: 'who', className: 'bt-work-who' },
    h(BotMark, { bot, size: 32, state: running ? (asking ? 'alert' : workState(entry)) : 'idle' }),
    h('span', { className: 'bt-work-text' },
      h('span', { className: 'bt-work-name' }, bot.name, h('span', { className: 'bt-work-where' }, t('in {name}', { name: room.name }))),
      status),
    running && !asking ? h('button', { type: 'button', className: 'bt-member-stop', disabled: stopping, 'aria-label': `${t('Stop')} · ${bot.name}`, onClick: stop }, t('Stop')) : null)

  // The member went on with new work while an earlier turn shows; and the others at work
  // here, one click away.
  const strip = target?.newer !== undefined || others.length > 0
    ? h('div', { key: 'strip', className: 'bt-work-strip' },
      target?.newer !== undefined
        ? h('button', { type: 'button', className: 'bt-work-link', onClick: () => actions.showMemberWork(room.id, bot.id, target.newer) }, t('Show the turn it runs now'))
        : null,
      others.length > 0 ? h('span', { className: 'bt-work-others' },
        h('span', { className: 'bt-work-meta' }, t('Also at work')),
        others.map((other) => {
          const peer = roster.byId[other.botId]
          return peer ? h('button', { key: other.botId, type: 'button', className: 'bt-work-peer', title: peer.name, onClick: () => actions.showMemberWork(room.id, peer.id, workAt(other)) },
            h(BotMark, { bot: peer, size: 18 }), h('span', null, peer.name)) : null
        })) : null)
    : null

  const process = target === null
    ? null
    : actions.godbot?.memberProcess
      ? actions.godbot.memberProcess({ key: `${target.sessionId}:${target.turn}`, botId: bot.id, sessionId: target.sessionId, turn: target.turn, running })
      : h('div', { className: 'bt-muted' }, t('This window cannot show the work process'))
  return [head, who, strip,
    h('div', { key: 'body', ref: body, className: 'bt-drawer-body bt-work-body', onScroll },
      h('div', { ref: content, className: 'bt-work-content' }, process))]
}

export const MEMBER_WORK_CSS = `
.bt-work-who{display:flex;align-items:center;gap:10px;padding:10px 16px 8px}
.bt-work-who>.bt-mark{flex:none}
.bt-work-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-work-name{min-width:0;font-size:14px;line-height:20px;font-weight:600;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-work-where{margin-left:6px;font-weight:400;font-size:12px;color:var(--bt-ink-3)}
.bt-work-status{display:flex;align-items:baseline;gap:4px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap}
.bt-work-status.bt-mw-ask{color:#b7791f}
body[data-ds-dark-theme] .bt-work-status.bt-mw-ask{color:#f0b84a}
.bt-work-what{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bt-work-meta{flex:none;color:var(--bt-ink-3);font-size:12px;font-variant-numeric:tabular-nums}
.bt-work-strip{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:0 16px 8px}
.bt-work-link{padding:0;border:0;background:none;color:var(--bt-accent,var(--bt-ink-2));font:inherit;font-size:12px;cursor:pointer}
.bt-work-link:hover{text-decoration:underline}
.bt-work-others{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px}
.bt-work-peer{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px 0 3px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer}
.bt-work-peer:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-work-body{border-top:.5px solid var(--bt-line);padding-top:12px}
.bt-work-content{min-width:0}
`
