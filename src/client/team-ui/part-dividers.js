// The lines between the earlier parts of a session (cells.js EarlierParts). An
// earlier part nobody talked in shows nothing but its line. Lines in a row keep the last
// one, and the line where the current part begins (drawn after these) needs none right
// above it. With every earlier part loaded (`complete`), a line with nothing above it
// marks no boundary either: the parts before it were all empty, and its time is when
// the part after it became current, not when the messages under it were written.
export function withoutEmptyParts(items, { complete = false } = {}) {
  const kept = items.filter((item, index) => item?.kind !== 'divider'
    || (index + 1 < items.length && items[index + 1]?.kind !== 'divider'))
  return complete && kept[0]?.kind === 'divider' ? kept.slice(1) : kept
}

// The session a New session was started from, as its package names it (parts.js
// handoffSource, openingSource). A package written before it did names none: switching
// sessions reorders a thread's earlier parts, so the one before it in the thread need
// not be where it came from. Only a part the session list can open counts.
export function previousPart(bot, sessionId, source) {
  const from = source?.fromPart
  if (bot === undefined || typeof from !== 'string' || from === sessionId) return undefined
  const openable = (bot.parts ?? []).includes(from) || (bot.openParts ?? []).some(part => part.sessionId === from)
  return openable ? from : undefined
}
