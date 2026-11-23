// A Bot's chat sessions as the session lists show them: the details panel's list and the
// one under the Bot's row in the sidebar.
import { currentPart, relativeShort } from './text.js'
import { t } from './i18n.js'

// Every session of a Bot's own chat: the current one, each one going on in the
// background, and the earlier ones of every chain, newest first. A session nobody talked
// in holds nothing to go back to and is left out, unless it is current or still running.
// `number` counts sessions in the order they were made; `title` is the first thing the
// user asked in it, as the host reads it (`roster.partTitles`).
export function botSessions(bot, roster) {
  const current = currentPart(bot)
  const empty = new Set(roster.emptyParts?.[bot.id] ?? [])
  const running = roster.partsRunning ?? {}
  const background = new Set((bot.openParts ?? []).map(part => part.sessionId))
  const ids = [current, ...background, ...(bot.parts ?? []), ...(bot.openParts ?? []).flatMap(part => part.parts ?? [])]
    .filter((id, index, list) => typeof id === 'string' && id !== '' && list.indexOf(id) === index)
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
