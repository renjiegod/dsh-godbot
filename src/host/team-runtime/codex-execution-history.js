import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const turnPageSize = 16
const maxPages = 3

async function matchesThread(thread, id, cwd) {
  if (thread?.id !== id || thread.ephemeral || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd)) return false
  if (resolve(thread.cwd) === resolve(cwd)) return true
  try {
    const [actual, expected] = await Promise.all([realpath(thread.cwd), realpath(cwd)])
    return actual === expected
  } catch {
    return false
  }
}

function iso(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined
}

function itemTime(items, field, choose) {
  let timestamp
  for (const item of items) {
    const value = item?.[field]
    if (Number.isFinite(value)) timestamp = timestamp === undefined ? value : choose(timestamp, value)
  }
  return iso(timestamp)
}

function turnOf(turn, toolOf) {
  if (typeof turn?.id !== 'string' || !turn.id || turn.status === 'inProgress' || !Array.isArray(turn.items) ||
      (turn.itemsView !== undefined && turn.itemsView !== 'full')) return
  const events = []
  for (const item of turn.items) {
    let event
    if (item?.type === 'userMessage' && Array.isArray(item.content)) {
      const text = item.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n')
      const images = item.content.some(block => block?.type === 'image' || block?.type === 'localImage')
      if (text || images) event = { type: 'input', text: text || '[Image]' }
    } else if (['agentMessage', 'agent_message', 'plan'].includes(item?.type)) {
      if (typeof item.text === 'string' && item.text) event = { type: 'text', text: item.text }
    } else if (item && typeof item === 'object') event = toolOf(item)
    if (event) events.push({ ...event, seq: events.length + 1 })
  }
  if (!events.length) return
  // Legacy rollouts may carry no per-turn times. Leave them undated rather
  // than using thread creation time for a later turn.
  const startedAt = (Number.isFinite(turn.startedAt) ? iso(turn.startedAt * 1000) : undefined) ?? itemTime(turn.items, 'startedAtMs', Math.min) ?? ''
  const endedAt = (Number.isFinite(turn.completedAt) ? iso(turn.completedAt * 1000) : undefined) ?? itemTime(turn.items, 'completedAtMs', Math.max)
  return { nativeTurnId: turn.id, startedAt, endedAt, events }
}

// Read exactly the caller's saved Codex thread. This never loads or subscribes
// to that conversation, so fetching history cannot take over a live terminal.
export async function readBoundCodexHistory(peer, { cwd, cliSessionId: threadId } = {}, { signal, toolOf }) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof threadId !== 'string' || !threadId) return []
  const opts = { signal, timeout: 3000 }
  try {
    const { thread } = await peer.request('thread/read', { threadId }, opts)
    if (!await matchesThread(thread, threadId, cwd)) return []
    let turns = []
    if (thread.historyMode === 'paginated') {
      const ids = new Set()
      let cursor
      for (let pageNo = 0; pageNo < maxPages; pageNo++) {
        const page = await peer.request('thread/turns/list', {
          threadId, sortDirection: 'desc', itemsView: 'full', limit: turnPageSize, ...(cursor ? { cursor } : {}),
        }, opts)
        if (!Array.isArray(page?.data) || !page.data.length) break
        for (const turn of page.data) {
          if (ids.has(turn?.id)) continue
          ids.add(turn?.id)
          turns.push(turn)
        }
        if (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === cursor) break
        cursor = page.nextCursor
      }
      turns.reverse()
    } else {
      const { thread: detailed } = await peer.request('thread/read', { threadId, includeTurns: true }, opts)
      if (!await matchesThread(detailed, threadId, cwd) || !Array.isArray(detailed.turns)) return []
      turns = detailed.turns.slice(-turnPageSize * maxPages)
    }
    return turns.map(turn => turnOf(turn, toolOf)).filter(Boolean)
  } catch {
    return []
  }
}
