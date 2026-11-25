// A Bot's chat sessions as the session lists show them: the details panel's list and the
// menu in the chat's top bar (session-menu.js).
import { currentPart, relativeShort } from './text.js'
import { t } from './i18n.js'

// Every part of a Bot's own chat, whichever is current: the current one, each one going
// on in the background, and the earlier ones of every chain.
export const ownPartIds = bot => [currentPart(bot), ...(bot.openParts ?? []).map(part => part.sessionId), ...(bot.parts ?? []), ...(bot.openParts ?? []).flatMap(part => part.parts ?? [])]
  .filter((id, index, list) => typeof id === 'string' && id !== '' && list.indexOf(id) === index)

// When a Bot was last active, for the sidebar's order: the latest activity in any of its
// sessions (`stamps`: session id → DSH's updatedAt), else when the Bot was made. Opening
// an older session changes which one is current, not this, so the Bot stays in place.
export const lastActivity = (bot, stamps) => Math.max(0, ...ownPartIds(bot).map(id => stamps[id] ?? 0)) || bot.createdAt

// Every session of a Bot's own chat: the current one, each one going on in the
// background, and the earlier ones of every chain, in reverse creation order. A session
// nobody talked in is left out, unless it is current or still running.
// `number` counts sessions in the order they were made; `title` is the first thing the
// user asked in it, as the host reads it (`roster.partTitles`).
export function botSessions(bot, roster) {
  const current = currentPart(bot)
  const empty = new Set(roster.emptyParts?.[bot.id] ?? [])
  const running = roster.partsRunning ?? {}
  const background = new Set((bot.openParts ?? []).map(part => part.sessionId))
  const ids = ownPartIds(bot)
  // The host orders parts by when DSH made them; one it has not ordered yet comes last.
  const order = [...(bot.partOrder ?? []), ...[...ids].reverse()].filter((id, index, list) => list.indexOf(id) === index)
  const numbers = new Map(order.map((id, index) => [id, index + 1]))
  return ids
    .filter(id => id === current || running[id] === true || !empty.has(id))
    .map(id => ({
      id,
      number: numbers.get(id),
      current: id === current,
      background: background.has(id),
      running: running[id] === true,
      waiting: roster.questions?.[id] !== undefined,
      title: roster.partTitles?.[id] ?? '',
    }))
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
}

const sessionDetails = row => {
  const at = row?.updatedAt ?? row?.createdAt
  return { rowTitle: row?.title, at: Number.isFinite(at) && at > 0 ? at : 0 }
}
const detailsEqual = (a, b) => a.length === b.length && a.every((row, index) => row.rowTitle === b[index].rowTitle && row.at === b[index].at)
const runningRank = entry => Number(entry.running && !entry.waiting)

// Running rows come first. Within each set, both lists sort by the DSH timestamp they
// display. The creation number breaks ties, including when there is no DSH summary.
export function useBotSessionRows(bot, roster, useSessions) {
  const entries = botSessions(bot, roster)
  const details = useSessions(list => entries.map(entry => sessionDetails(list.byId?.[entry.id])), detailsEqual)
  return entries
    .map((entry, index) => ({ ...entry, ...details[index] }))
    .sort((a, b) => runningRank(b) - runningRank(a) || b.at - a.at || b.number - a.number)
}

// A session's name: what the user first asked in it. A part is made under the Bot's
// name, which every row would repeat, so a DSH title only names it when it is its own;
// otherwise a current part nobody talked in (`roster.newSessions`) is the New session,
// and any other is numbered.
export function sessionLabel(entry, { bot, roster, rowTitle }) {
  if (entry.title !== '') return entry.title
  const own = typeof rowTitle === 'string' ? rowTitle.trim() : ''
  if (own !== '' && own !== bot.name) return own
  if (entry.current && roster.newSessions?.[bot.id] === 'empty') return t('New session')
  return t('Session {number}', { number: entry.number })
}

// Title shown in the top bar for the open conversation: the Bot session's prompt or
// session label (to pair with the Bot pill), or a group's distinct topic title.
// Non-team sessions already place their title in the header pill itself.
export function conversationTitle(sessionId, { bot, room, roster, title } = {}) {
  if (roster?.ready === false) return ''
  if (bot) {
    const sessions = botSessions(bot, roster ?? {})
    const partIndex = (bot.partOrder ?? []).indexOf(sessionId)
    const entry = sessions.find(e => e.id === sessionId) ?? {
      id: sessionId,
      number: partIndex >= 0 ? partIndex + 1 : 1,
      current: currentPart(bot) === sessionId,
      title: roster?.partTitles?.[sessionId] ?? '',
    }
    return sessionLabel(entry, { bot, roster: roster ?? {}, rowTitle: title })
  }
  if (room) {
    const clean = typeof title === 'string' ? title.trim() : ''
    return clean !== '' && clean !== room.name ? clean : ''
  }
  return ''
}

// Browser tab title for the open conversation, keeping the Bot or group name as suffix.
export function documentTitle({ ready, showGoal, goalTitle, conversationTitle: titleValue, name, title } = {}) {
  if (ready === false) return ''
  if (showGoal && goalTitle) return name ? `${goalTitle} · ${name}` : goalTitle
  if (titleValue && name && titleValue !== name) return `${titleValue} · ${name}`
  return titleValue || name || title || t('New chat')
}

// What a row says on its right: a question waiting for the user, a turn running, else
// how long ago the session was last active.
export function sessionMeta(entry, at) {
  if (entry.waiting) return { tone: 'wait', text: t('Waiting for your answer') }
  if (entry.running) return { tone: 'run', text: t('Running') }
  return { tone: undefined, text: Number.isFinite(at) && at > 0 ? relativeShort(at) : '' }
}

// The exact time for a row's tooltip.
export const sessionTime = at => (Number.isFinite(at) && at > 0
  ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '')

// The rows a short list keeps: the current session and every one running or waiting
// for the user, then the newest of the rest up to `limit`, in list order.
export function shortList(entries, limit) {
  const kept = new Set(entries.filter(entry => entry.current || entry.running || entry.waiting).map(entry => entry.id))
  for (const entry of entries) {
    if (kept.size >= limit) break
    kept.add(entry.id)
  }
  return entries.filter(entry => kept.has(entry.id))
}
