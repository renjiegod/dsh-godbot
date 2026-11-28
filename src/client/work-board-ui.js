import { createElement as h } from 'react'
import { t } from './team-ui/i18n.js'
import { BotMark, RoomAvatar } from './team-ui/mark.js'
import { CalendarIcon, PeopleIcon } from './team-ui/icons.js'
import { markNames, phaseNames } from '../host/team-runtime/shared/work-board.js'
import { priorities } from '../team/work-board-planning.js'

/** Resolve assignee id/label and render matching BotMark / RoomAvatar / user badge. */
export function resolveAssignee(target, view, roster) {
  const raw = target?.fields?.assignee || target?.assignee || (target?.owner ? 'bot/' + target.owner : '')
  if (!raw) return { kind: 'none', name: t('Unassigned') }
  if (raw.startsWith('bot/')) {
    const id = raw.slice(4)
    const bot = roster?.byId?.[id] ?? view?.bots?.find(b => b.id === id) ?? { id, name: id }
    return { kind: 'bot', id, bot, name: bot.name || t('Unassigned') }
  }
  if (raw.startsWith('room/')) {
    const id = raw.slice(5)
    const room = roster?.roomsById?.[id]
    const catalogEntry = view?.catalog?.assignees?.find(a => a.id === raw)
    const roomInfo = view?.rooms?.find(r => r.id === id)
    return { kind: 'room', id, room, name: catalogEntry?.name ?? room?.name ?? roomInfo?.name ?? id }
  }
  if (raw.startsWith('person/')) {
    const catalogEntry = view?.catalog?.assignees?.find(a => a.id === raw)
    return { kind: 'person', id: raw, name: t(catalogEntry?.name ?? 'Workspace owner') }
  }
  const bot = roster?.byId?.[raw] ?? view?.bots?.find(b => b.id === raw)
  return bot ? { kind: 'bot', id: raw, bot, name: bot.name } : { kind: 'none', name: t('Unassigned') }
}

/** Compact owner avatar + name chip shared by board cards, table rows, and detail drawer. */
export function OwnerMark({ target, view, roster, size = 18, live = false, showName = true, className = 'wb-owner' }) {
  const info = resolveAssignee(target, view, roster)
  let icon
  if (info.kind === 'bot') {
    icon = h(BotMark, { bot: info.bot, size, live })
  } else if (info.kind === 'room') {
    icon = info.room && roster?.byId
      ? h(RoomAvatar, { room: info.room, roster, size })
      : h('span', { className: 'wb-avatar-room', style: { width: size, height: size }, 'aria-hidden': true }, h(PeopleIcon))
  } else if (info.kind === 'person') {
    icon = h('span', { className: 'wb-avatar-you', style: { width: size, height: size }, 'aria-hidden': true },
      Array.from(info.name)[0] ?? 'U')
  } else {
    icon = h('span', { className: 'wb-avatar-empty', style: { width: size, height: size }, 'aria-hidden': true })
  }
  return h('span', { className, 'data-unassigned': info.kind === 'none' || undefined },
    icon,
    showName ? h('span', { className: 'wb-owner-name' }, info.name) : null,
  )
}

/** Priority badge with semantic tone; Normal (0) and No priority (4) stay quiet on cards. */
export function PriorityBadge({ priority, showNormal = false }) {
  if (priority == null || (!showNormal && (priority === 0 || priority === 4))) return null
  const key = priorities[priority] ? priority : 0
  return h('span', { className: 'wb-priority', 'data-priority': String(key) },
    h('span', { className: 'wb-priority-dot', 'aria-hidden': true }),
    t(priorities[key]),
  )
}

/** Semantic status pill with phase color indicator. */
export function StatusPill({ phase, label }) {
  return h('span', { className: 'wb-status-pill', 'data-phase': phase || 'todo' },
    h('span', { className: 'wb-status-dot', 'aria-hidden': true }),
    h('span', null, label),
  )
}

/** Resolve displayed status text from custom status catalog or mark label. */
export function statusLabel(item, catalog) {
  const custom = catalog?.statuses?.find(s => s.id === item?.statusId)?.name
  if (custom) return custom
  return t(markNames[item?.mark] ?? phaseNames[item?.phase] ?? item?.mark ?? 'Unknown')
}

/** Date pill highlighting overdue open items cleanly without hardcoding hex colors. */
export function DateChip({ value, phase, prefix }) {
  if (!value) return null
  const today = new Date().toISOString().slice(0, 10)
  const overdue = prefix !== 'start' && !['done', 'history'].includes(phase) && value < today
  return h('span', { className: 'wb-chip wb-chip-date', 'data-overdue': overdue || undefined },
    h(CalendarIcon),
    h('span', null, value),
  )
}

/** Crisp 14px layout icons for the segmented view bar. */
export function LayoutIcon({ kind }) {
  const props = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (kind === 'board') {
    return h('svg', props, h('rect', { x: 2, y: 2.5, width: 3.2, height: 11, rx: 0.8 }), h('rect', { x: 6.4, y: 2.5, width: 3.2, height: 8, rx: 0.8 }), h('rect', { x: 10.8, y: 2.5, width: 3.2, height: 9.5, rx: 0.8 }))
  }
  if (kind === 'list') {
    return h('svg', props, h('path', { d: 'M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5' }), h('circle', { cx: 2.8, cy: 4, r: 0.7, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 2.8, cy: 8, r: 0.7, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 2.8, cy: 12, r: 0.7, fill: 'currentColor', stroke: 'none' }))
  }
  if (kind === 'table') {
    return h('svg', props, h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }), h('path', { d: 'M2 6.2h12M6.2 6.2v7.3' }))
  }
  if (kind === 'swimlane') {
    return h('svg', props, h('rect', { x: 2, y: 2.5, width: 12, height: 4.5, rx: 1 }), h('rect', { x: 2, y: 9, width: 12, height: 4.5, rx: 1 }), h('path', { d: 'M6 2.5v4.5M10 2.5v4.5M6 9v4.5M10 9v4.5' }))
  }
  return h('svg', props, h('path', { d: 'M2.5 4.5h6M5.5 8h8M3.5 11.5h5' }))
}

export const LAYOUT_SHORT_LABELS = {
  board: 'Board',
  list: 'List',
  table: 'Table',
  swimlane: 'Swimlane',
  gantt: 'Timeline',
}

export const PHASE_TITLES = {
  todo: 'To do',
  doing: 'In progress',
  attention: 'Needs attention',
  review: 'Awaiting review',
  done: 'Done',
  history: 'History',
}
