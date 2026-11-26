// A Bot's own chat is one or more threads. The current thread is `bot.sessionId` with
// its earlier parts in `bot.segments`; a thread opened while the Bot was busy keeps its
// own session and its own earlier parts in `bot.openParts`. Parts never share a chain:
// a handoff reads only the thread it belongs to, so background work and the foreground
// chat cannot leak into each other.
// A Bot that never ran yet has no stored session id: its first Session is the Bot id
// (store.js chatOf falls back to it).
export const currentSession = bot => bot?.sessionId ?? bot?.id

const endsConversation = part => part?.manual === true || part?.cut === true || part?.fallback === 'manual'

export function sessionFloor(parts, at) {
  for (let index = at - 1; index >= 0; index -= 1) {
    if (endsConversation(parts[index])) return index + 1
  }
  return 0
}

export function currentConversationParts(bot, sessionId) {
  const segments = bot.segments ?? []
  const floor = sessionFloor(segments, segments.length)
  return [...segments.slice(floor).map(segment => segment.sessionId), sessionId]
}

// Each live thread can also hold archived conversations behind a New session or
// session-selection boundary. Only the contiguous parts share a conversation.
export function ownConversations(bot) {
  if (bot === undefined) return []
  const open = []
  const archived = []
  for (const thread of [bot, ...(bot.openParts ?? []).toReversed()]) {
    let parts = []
    for (const segment of thread.segments ?? []) {
      parts.push(segment.sessionId)
      if (!endsConversation(segment)) continue
      archived.push({ sessionId: segment.sessionId, parts, endedAt: segment.endedAt ?? 0 })
      parts = []
    }
    const sessionId = thread === bot ? currentSession(bot) : thread.sessionId
    open.push({ sessionId, parts: [...parts, sessionId] })
  }
  return [...open, ...archived.sort((a, b) => b.endedAt - a.endedAt)]
}

export function conversationHead(bot, partId) {
  if (partId === undefined) return undefined
  if (threadOf(bot, partId) !== undefined) return partId
  const place = earlierPlace(bot, partId)
  if (place === undefined) return undefined
  return place.segments.slice(place.at).find(endsConversation)?.sessionId
    ?? (place.thread === 'current' ? currentSession(bot) : bot.openParts[place.index].sessionId)
}

export function threadOf(bot, sessionId) {
  if (bot === undefined || sessionId === undefined) return undefined
  if (currentSession(bot) === sessionId) return { thread: 'current', segments: bot.segments ?? [] }
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  return at === -1 ? undefined : { thread: 'open', index: at, segments: bot.openParts[at].segments ?? [] }
}

export const threadSegments = (bot, sessionId) => threadOf(bot, sessionId)?.segments ?? []

export const isOpenPart = (bot, sessionId) => threadOf(bot, sessionId)?.thread === 'open'

// A thread's current session: the part that a handoff or a kept input belongs to.
export function threadCurrent(bot, sessionId) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
}

// The thread a part belongs to, whether it is that thread's current part or one of its
// earlier parts. A Session outside the Bot's own chat (a group Session) belongs to none.
// `threadOf` alone knows only the current part of each thread; the earlier parts are
// still readable, and their history belongs to the thread they came from.
export function threadOfPart(bot, sessionId) {
  const found = threadOf(bot, sessionId)
  if (found !== undefined || bot === undefined || sessionId === undefined) return found
  if ((bot.segments ?? []).some(segment => segment.sessionId === sessionId)) return { thread: 'current', segments: bot.segments }
  const at = (bot.openParts ?? []).findIndex(part => (part.segments ?? []).some(segment => segment.sessionId === sessionId))
  return at === -1 ? undefined : { thread: 'open', index: at, segments: bot.openParts[at].segments ?? [] }
}

// The session a part's thread goes on in: a reply to, or input given to, an earlier part
// of a thread reaches the part that thread has now.
export function threadCurrentOfPart(bot, sessionId) {
  const thread = threadOfPart(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
}

// A fresh part replaces a thread's current one; the part it replaces joins that thread's
// own earlier parts. Returns false for a session that belongs to no thread.
export function pushThreadPart(bot, sessionId, freshId, segment) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return false
  if (thread.thread === 'current') {
    ;(bot.segments ??= []).push(segment)
    bot.sessionId = freshId
  } else {
    const part = bot.openParts[thread.index]
    ;(part.segments ??= []).push(segment)
    part.sessionId = freshId
  }
  return true
}

// When a thread began: the Bot's chat began with the Bot, and a thread a New session
// opened while the Bot was busy began when its first part was made. That time sits on
// the Bot for its current thread and on each open part for its own (`threadStartedAt`),
// and travels with the thread when the two swap. A thread saved before this was kept
// has none and reads as begun with the Bot.
const threadBegun = at => (Number.isFinite(at) ? { threadStartedAt: at } : {})

export function addBackgroundConversation(bot, sessionId, now = Date.now()) {
  ;(bot.openParts ??= []).push({ sessionId, segments: [], startedAt: now, threadStartedAt: now })
}

export function reopenBackgroundConversation(bot, sessionId, now = Date.now()) {
  const place = earlierPlace(bot, sessionId)
  if (place === undefined || !endsConversation(place.segments[place.at])) return false
  const { segments, at } = place
  const owner = place.thread === 'current' ? bot : bot.openParts[place.index]
  const floor = sessionFloor(segments, at)
  const startedAt = floor > 0 ? segments[floor - 1].endedAt : owner.threadStartedAt ?? bot.createdAt
  const earlier = segments.splice(floor, at - floor + 1)
  const head = earlier.pop()
  if (floor === 0 && Number.isFinite(head.endedAt)) owner.threadStartedAt = head.endedAt
  ;(bot.openParts ??= []).push({ sessionId, segments: earlier, startedAt: now, ...threadBegun(startedAt) })
  return true
}

export function threadStart(bot, sessionId) {
  const thread = threadOfPart(bot, sessionId)
  if (thread === undefined) return undefined
  const at = thread.thread === 'current' ? bot.threadStartedAt : bot.openParts[thread.index].threadStartedAt
  return Number.isFinite(at) ? at : undefined
}

// A fresh part starts in the foreground while the part it replaces stays live in the
// background with its own chain, so its running turn is not interrupted. It starts with
// no earlier parts and no handoff note: the user asked for a new conversation.
export function startOpenPart(bot, freshId, startedAt = Date.now()) {
  bot.openParts ??= []
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], startedAt, ...threadBegun(bot.threadStartedAt) })
  bot.sessionId = freshId
  bot.segments = []
  bot.threadStartedAt = startedAt
}

// Makes a live background part current. Each chain travels with its parts.
export function focusOpenPart(bot, sessionId) {
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  if (at === -1) return false
  const [target] = bot.openParts.splice(at, 1)
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], ...threadBegun(bot.threadStartedAt) })
  bot.sessionId = target.sessionId
  bot.segments = target.segments ?? []
  if (Number.isFinite(target.threadStartedAt)) bot.threadStartedAt = target.threadStartedAt
  else delete bot.threadStartedAt
  return true
}

// Where an earlier part sits: in the current thread's chain, or in the chain of a thread
// that goes on in the background.
export function earlierPlace(bot, sessionId) {
  if (bot === undefined || sessionId === undefined) return undefined
  const at = (bot.segments ?? []).findIndex(segment => segment?.sessionId === sessionId)
  if (at !== -1) return { thread: 'current', at, segments: bot.segments }
  for (const [index, part] of (bot.openParts ?? []).entries()) {
    const found = (part?.segments ?? []).findIndex(segment => segment?.sessionId === sessionId)
    if (found !== -1) return { thread: 'open', index, at: found, segments: part.segments }
  }
  return undefined
}

// A chain without one of its parts. The parts on either side of it never followed each
// other, so the one before it is marked `cut`: pages of the part after it stop there.
const withoutPart = (segments, at) => segments.flatMap((segment, index) => (index === at ? [] : index === at - 1 ? [{ ...segment, cut: true }] : [segment]))

// Takes an earlier part out of its chain. A chain that loses its first part now begins
// where that part ended, which is when the next one began. Returns when the part itself
// began.
function takeOut(bot, place) {
  const chainBegun = place.thread === 'current' ? bot.threadStartedAt : bot.openParts[place.index].threadStartedAt
  const begun = place.at > 0 ? place.segments[place.at - 1]?.endedAt : chainBegun
  const restBegun = place.at === 0 ? place.segments[0]?.endedAt : chainBegun
  const rest = withoutPart(place.segments, place.at)
  if (place.thread === 'current') {
    bot.segments = rest
    if (Number.isFinite(restBegun)) bot.threadStartedAt = restBegun
  } else {
    bot.openParts[place.index] = { ...bot.openParts[place.index], segments: rest, ...threadBegun(restBegun) }
  }
  return begun
}

// Opening an earlier part while the current one runs: the running part goes on in the
// background, its turn untouched, with its own chain, as a New session leaves it. The
// part opened leaves the chain it sat in and becomes current as a thread of its own,
// begun when the part itself began. Returns false for a part that is in no chain.
export function openEarlierBeside(bot, sessionId, now = Date.now()) {
  const place = earlierPlace(bot, sessionId)
  if (place === undefined) return false
  const begun = takeOut(bot, place)
  bot.openParts ??= []
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], startedAt: now, ...threadBegun(bot.threadStartedAt) })
  bot.sessionId = sessionId
  bot.segments = []
  if (Number.isFinite(begun)) bot.threadStartedAt = begun
  else delete bot.threadStartedAt
  return true
}

// Opening an earlier part of a background thread while the current part is idle: it
// leaves that chain, and the current part joins the current chain's earlier parts in
// its place. Returns false for a part that is in no background chain.
export function openEarlierOfThread(bot, sessionId, now = Date.now()) {
  const place = earlierPlace(bot, sessionId)
  if (place?.thread !== 'open') return false
  takeOut(bot, place)
  ;(bot.segments ??= []).push({ sessionId: currentSession(bot), endedAt: now, cut: true })
  bot.sessionId = sessionId
  return true
}

// Every session this Bot keeps outside its current thread, for cleanup, memory and the
// session list.
export const openSessions = bot => (bot?.openParts ?? []).flatMap(part => [part.sessionId, ...(part.segments ?? []).map(segment => segment.sessionId)])

// Every part of a Bot's own chat: the current one, each background thread's current
// one, and the earlier parts of every chain.
export const ownChatParts = bot => [currentSession(bot), ...(bot?.segments ?? []).map(segment => segment?.sessionId), ...openSessions(bot)]
  .filter((id, index, list) => id !== undefined && list.indexOf(id) === index)

// A part that just moved on records a successor only when it belongs to an open thread:
// the foreground chat keeps its current part in `bot.sessionId`. The thread is read
// again after the move, because the user may have opened another part while the switch
// ran and turned this one into a background thread.
export const successorOfMovedPart = (bot, freshId) => (threadOf(bot, freshId)?.thread === 'open' ? freshId : undefined)

// Every live thread's current session. A change that must reach all of a Bot's own
// chats (its run mode) walks these, so no thread can be left on the other side.
export const ownChatSessions = bot => [currentSession(bot), ...(bot?.openParts ?? []).map(part => part.sessionId)].filter((id, index, list) => id !== undefined && list.indexOf(id) === index)
