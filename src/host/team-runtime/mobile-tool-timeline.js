import { createHash } from 'node:crypto'
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm'
import { bindToolSlots, readToolActivity, toolSlots } from './shared/tool-timeline.js'
import { turnOutcome } from './shared/turn-outcome.js'

// A follow opening is a consistent cut of the saved events and the current
// assistant attempt. Returning from the loop also releases the subscription.
export async function openChatPage(controller, request, signal) {
  for await (const frame of controller.follow({ address: request.address, maxMessages: request.maxMessages, assistantStream: true }, signal)) {
    if (frame.type === 'snapshot') return frame
  }
  throw new Error('Chat closed before its opening snapshot')
}

export function withLiveAttempt(events, attempt) {
  if (!attempt || events.some(event => (event.type === 'assistant/message' || event.type === 'assistant/attempt') && event.seq > attempt.startedAfterSeq &&
    event.data?.turn === attempt.turn && event.data?.step === attempt.step)) return events
  // Host tool calls get their own dispatch events. Only text and local-agent
  // activity markers are presented before the assistant message is committed.
  const content = assembleAssistantStream(attempt.stream).interruptedBlocks()
  if (!content.length) return events
  const first = attempt.stream[0]
  const live = { type: 'assistant/message', time: first?.time0 ?? first?.time,
    data: { turn: attempt.turn, step: attempt.step, message: { content } } }
  const next = events.findIndex(event => event.seq > attempt.startedAfterSeq)
  return next < 0 ? [...events, live] : [...events.slice(0, next), live, ...events.slice(next)]
}

export function interruptedAttemptContent(event) {
  return Array.isArray(event.data?.stream) ? assembleAssistantStream(event.data.stream).interruptedBlocks() : []
}

// DSH stores a request that failed as an attempt. Keep the last visible
// attempt of an interrupted turn, while hiding attempts the next reply replaced.
export function withInterruptedAttempts(events) {
  const interrupted = new Set()
  const attempts = new Map()
  for (const event of events) {
    const turn = event.data?.turn
    if (event.type === 'assistant/attempt') attempts.set(turn, event)
    else if (event.type === 'assistant/message') attempts.delete(turn)
    else if (event.type === 'turn/end' && turnOutcome(event.data.reason)?.status === 'interrupted') interrupted.add(turn)
  }
  if (interrupted.size === 0 || attempts.size === 0) return events
  return events.map(event => {
    const data = event.data
    if (event.type !== 'assistant/attempt' || attempts.get(data.turn) !== event || !interrupted.has(data.turn)) return event
    const content = interruptedAttemptContent(event)
    return { ...event, type: 'assistant/message', data: { turn: data.turn, step: data.step, message: { content } } }
  })
}

const interactive = new Set(['ask_user', 'request_secret', 'show_view', 'group_relay'])

export async function mobileToolDetail(rt, { botId, sessionId, turn, toolId }, { associatedWork = false } = {}) {
  const history = rt.executionHistory
  if (!history || typeof botId !== 'string' || history.ownerOf(sessionId) !== botId ||
      typeof toolId !== 'string' || !toolId || !Number.isSafeInteger(turn) ||
      (!associatedWork && rt.state.exchangeTurns?.[sessionId]?.includes(turn))) throw new Error('Tool call unavailable')
  const { events } = await history.read({ botId, sessionId, turn, toolId })
  const tool = events[0]
  if (!tool || interactive.has(tool.name)) throw new Error('Tool call unavailable')
  const fields = {}
  for (const key of ['cwd', 'input', 'output', 'error', 'changes']) {
    if (tool[key] == null) continue
    const text = typeof tool[key] === 'string' ? tool[key] : JSON.stringify(tool[key], (_, value) =>
      value?.type === 'base64' && typeof value.data === 'string' ? { ...value, data: '…' } : value, 2)
    fields[key] = text.length > 8192 || tool.truncatedFields?.includes(key) ? text.slice(0, 8192) + '…' : text
  }
  return fields
}

// A whole turn's process for a phone (a group member's work panel): what the Bot wrote
// between its calls, and each call as its card shows it, in the order the web's
// execution timeline shows them. Inputs and outputs stay here until a card opens its
// call with `chat-tool`. `rev` names the answer: a phone reading again while the turn
// runs gets `unchanged` instead of the same rows.
const PROCESS_ROWS = 500
const PROCESS_TEXT = 4000
const PROCESS_TARGET = 400
const clip = (text, max) => text.length > max ? text.slice(0, max) + '…' : text
const locationText = location => typeof location === 'string' ? location : typeof location?.path === 'string'
  ? location.path + (location.line != null ? ':' + location.line : '') : ''

export async function mobileTurnProcess(rt, { botId, sessionId, turn, knownRev, before }, { associatedWork = false } = {}) {
  const history = rt.executionHistory
  if (!history || typeof botId !== 'string' || typeof sessionId !== 'string' || history.ownerOf(sessionId) !== botId ||
      !Number.isSafeInteger(turn) || (!associatedWork && rt.state.exchangeTurns?.[sessionId]?.includes(turn))) throw new Error('Work process unavailable')
  const { events, running } = await history.read({ botId, sessionId, turn })
  const clean = text => rt.redactSecrets?.(text) ?? text
  const rows = []
  for (const event of events) {
    if (event?.type === 'tool') {
      // Every call counts, as on the web; interactive ones show without details. What it
      // works on is named as the web's timeline names it: its location, the name it carries
      // itself, else the host's `target` read from its input (execution-history.js).
      const id = typeof event.id === 'string' && event.id !== '' ? event.id : undefined
      const target = (Array.isArray(event.locations) && locationText(event.locations[0])) || event.text || event.target
      rows.push({
        type: 'tool',
        ...(id !== undefined && !interactive.has(event.name) ? { toolId: id } : {}),
        name: typeof event.name === 'string' && event.name !== '' ? event.name : id ?? '',
        ...(typeof event.status === 'string' ? { status: event.status } : {}),
        ...(typeof target === 'string' && target !== '' ? { text: clip(clean(target), PROCESS_TARGET) } : {}),
        ...(Number.isFinite(event.exitCode) ? { exitCode: event.exitCode } : {}),
        ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
        ...(typeof event.parentId === 'string' && event.parentId !== '' ? { parentId: event.parentId } : {}),
      })
    } else if (['text', 'input', 'error'].includes(event?.type) && typeof event.text === 'string' && event.text.trim() !== '') {
      rows.push({ type: event.type, text: clip(clean(event.text), PROCESS_TEXT) })
    }
  }
  // A very long turn sends its newest rows; `omitted` counts the ones before them.
  const end = associatedWork && Number.isSafeInteger(before) && before > 0 ? Math.min(before, rows.length) : rows.length
  const omitted = Math.max(0, end - PROCESS_ROWS)
  const value = { running: running === true, events: rows.slice(omitted, end), ...(omitted > 0 ? { omitted } : {}) }
  const rev = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  return typeof knownRev === 'string' && knownRev === rev ? { running: value.running, rev, unchanged: true } : { ...value, rev }
}

// Anchor local calls to the reasoning block that recorded their start and
// native DSH calls to their dispatch. Receipts only update an existing row.
export function mobileToolRows(rt, sessionId, events, seedTurn) {
  const rows = new Map()
  const groups = new Map()
  const hidden = new Set(rt.state.exchangeTurns?.[sessionId] ?? [])
  const botId = rt.executionHistory?.ownerOf(sessionId)
  let turn = seedTurn
  for (const event of events) {
    turn = event.data?.turn ?? turn
    if (!Number.isSafeInteger(turn) || hidden.has(turn)) continue
    const data = event.data ?? {}
    let group = groups.get(turn)
    if (!group) groups.set(turn, group = { markers: [], calls: new Map(), outcomes: new Map() })
    if (event.type === 'assistant/message') {
      const content = data.message?.content
      if (!Array.isArray(content)) continue
      for (const [index, block] of content.entries()) {
        if (block?.type !== 'reasoning' || typeof block.text !== 'string') continue
        for (const [line, value] of block.text.split('\n').entries()) {
          const activity = readToolActivity(value)
          if (activity) group.markers.push([{ anchor: block, key: `${data.step ?? event.seq}:${index}:${line}` }, activity])
        }
      }
    } else if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const id = data.subCallId ?? data.callId
      if (id && !group.calls.has(id)) group.calls.set(id, { event, name: data.name })
    } else if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const failed = data.message?.isError || data.message?.ok === false || data.isError
      group.outcomes.set(data.subCallId ?? data.message?.toolCallId ?? data.callId, failed ? 'failed' : 'completed')
    }
  }
  for (const [number, group] of groups) {
    if (!group.markers.length && !group.calls.size) continue
    const receipts = rt.executionHistory?.toolSummaries(sessionId, number) ?? []
    const byId = new Map(receipts.map(receipt => [receipt.id, receipt]))
    const bound = bindToolSlots(toolSlots(group.markers), receipts, new Set(group.calls.keys()))
    const active = rt.live?.get(sessionId)?.turn === number
    function add(anchor, key, tool) {
      if (!tool.name || interactive.has(tool.name)) return
      const status = !active && ['pending', 'running'].includes(tool.status) ? 'unknown' : tool.status ?? 'unknown'
      const toolId = byId.has(tool.id) ? tool.id : undefined
      const text = typeof tool.text === 'string' ? (rt.redactSecrets?.(tool.text) ?? tool.text).slice(0, 400) : undefined
      const row = { kind: 'tool', timelineId: JSON.stringify([sessionId, number, 'tool', tool.id ?? key]),
        sessionId, botId, turn: number, toolId, name: tool.name, text, status }
      const list = rows.get(anchor) ?? []
      list.push(row)
      rows.set(anchor, list)
    }
    for (const [slot, tool] of bound) {
      if (!group.calls.has(tool.id)) add(slot.anchor, slot.key, tool)
    }
    for (const [id, { event, name }] of group.calls) {
      add(event, id, { id, name, status: group.outcomes.get(id) ?? 'running', ...byId.get(id) })
    }
  }
  return rows
}
