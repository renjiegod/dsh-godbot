// What a group member's work panel shows, as plain data. The panel shows one turn of
// the member's group Session: the one its opener named (a group line's turn, or the
// live turn at the moment it opened), else the one the member runs there now.

// The turn a group line or a live work entry names, as the panel takes it.
export function workAt(value) {
  return typeof value?.sessionId === 'string' && value.sessionId !== '' && Number.isSafeInteger(value.turn)
    ? { sessionId: value.sessionId, turn: value.turn }
    : {}
}

// `at` is what the opener knew; `entry` the member's live work in this group, if it
// works there now. `running` says the shown turn is the live one; `newer` names the
// live turn when the panel shows another (the member went on with new work).
export function memberWorkTarget(at, entry) {
  const known = workAt(at)
  const live = workAt(entry)
  const shown = known.sessionId !== undefined ? known : live.sessionId !== undefined ? live : undefined
  if (shown === undefined) return null
  const same = live.sessionId === shown.sessionId && live.turn === shown.turn
  return { ...shown, running: same, ...(live.sessionId !== undefined && !same ? { newer: live } : {}) }
}

// A line of the group opens its turn's process only when the turn ran tools: a plain
// answer has nothing more to show than the line itself.
export const hasProcess = work => workAt(work).sessionId !== undefined && Number.isSafeInteger(work.tools) && work.tools > 0

// The other members at work in the group, for the panel's switcher: those whose live
// turn it can show.
export function otherWorkers(entries, botId) {
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => typeof entry?.botId === 'string' && entry.botId !== botId && workAt(entry).sessionId !== undefined)
    .map(entry => ({ botId: entry.botId, ...workAt(entry) }))
}
