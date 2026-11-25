import { claudeUsageFrame } from '../drivers/external/claude-usage-data.js'
import { claudeToolResult } from '../drivers/external/tool-results.js'
import { commandLabel, toolActivity } from './team-runtime/tool-activity.js'
import { skillNameFromPath, toolKind } from './team-runtime/shared/tool-kind.js'

const diagnosticToken = value => typeof value === 'string' && /^[\w.:-]{1,128}$/u.test(value) ? value : undefined
const lateCallLimit = 256

// Stream-json emits each content block in order, then repeats its complete
// value in one or more assistant frames (often one frame per block).
export function attachClaudeBotTimeline(session, { cwd, onControl, usageDelivery } = {}) {
  const receive = session.onLine.bind(session)
  const messages = new Map()
  const calls = new Map()
  const rounds = new Map()
  const textKey = (parentId, messageId, index) => JSON.stringify([parentId, messageId, index])
  const note = (text, fields) => session.noteDiagnostic?.(text, fields)

  function roundOf(turnId, messageId) {
    let round = rounds.get(turnId)
    if (round === undefined || (messageId !== undefined && messageId !== round.messageId)) {
      round = { messageId, calls: new Map() }
      rounds.set(turnId, round)
    }
    return round
  }

  function reportTool(block, parentId, partial, messageId) {
    if (block.name?.startsWith('mcp__godbot__')) return // The host records this call.
    const { id, name, input } = block
    const path = input?.file_path ?? input?.path
    const activityKind = name === 'Task' ? 'agent' : toolKind(name, path)
    const target = (activityKind === 'skill' ? input?.skill ?? skillNameFromPath(path) : undefined)
      ?? path ?? input?.description ?? commandLabel(input?.command)
    if (typeof id !== 'string' || !id) {
      if (!partial) session.emit(toolActivity(name, target, 'started'))
      return
    }
    const known = calls.get(id)
    if (partial && known) return
    const tool = known ?? { id, name, turnId: session.turns.owner(), startedAt: Date.now() }
    if (input?.file_path !== undefined) tool.filePath = input.file_path
    if (Number.isSafeInteger(input?.timeout)) tool.requestedTimeoutMs = input.timeout
    calls.set(id, tool)
    if (!known && parentId === undefined && tool.turnId !== undefined)
      roundOf(tool.turnId, messageId).calls.set(id, tool)
    const trace = { type: 'tool', id, name, activityKind, cwd, parentId, text: target,
      ...(!partial ? { input } : {}), ...(!known ? { status: 'running' } : {}) }
    session.emit({ ...(known ? { type: 'execution-trace' } : toolActivity(name, target, 'started')), trace })
  }

  // A result can arrive before a native tool receipt. Close the prompt with the
  // evidence it has, and keep the unresolved call's owner for a later receipt.
  session.onTurnResult = (event, answer) => {
    const { turn, finished = [] } = answer ?? {}
    const round = rounds.get(turn)
    const tools = [...(round?.calls.values() ?? [])]
    const pending = tools.filter(tool => tool.status === undefined)
    const unresolved = pending[0]
    const failed = tools.findLast(tool => tool.status === 'failed' || tool.status === 'interrupted')
    const noReply = event.stop_reason === 'tool_use' ? tools.at(-1) : undefined
    const incomplete = unresolved ?? failed ?? noReply
    const cause = unresolved ? 'tool-result-missing' : failed ? 'tool-failed-without-reply' : noReply ? 'tool-use-without-reply' : undefined
    note('Claude Code returned a turn result', {
      nativeEvent: 'result', nativeTurnId: diagnosticToken(turn), nativeSubtype: diagnosticToken(event.subtype),
      nativeStopReason: diagnosticToken(event.stop_reason), nativeOrigin: diagnosticToken(event.origin?.kind ?? event.origin),
      nativeError: event.is_error === true, nativeDurationMs: Number.isSafeInteger(event.duration_ms) ? event.duration_ms : undefined,
      pendingTools: pending.length, disposition: turn === undefined ? 'unattributed' : finished.includes(turn) ? 'settled' : 'awaiting-steer',
      ...(incomplete === undefined ? {} : { cause, toolId: diagnosticToken(incomplete.id), toolName: diagnosticToken(incomplete.name),
        exitCode: incomplete.exitCode, elapsedMs: Date.now() - incomplete.startedAt, requestedTimeoutMs: incomplete.requestedTimeoutMs }),
    })
    let lateCalls = 0
    for (const [id, tool] of calls) {
      if (tool.turnId === undefined ? turn === undefined : finished.includes(tool.turnId)) {
        if (tool.status !== undefined || tool.turnId === undefined) calls.delete(id)
        else tool.closed = true
      }
      if (tool.closed) lateCalls++
    }
    for (const [id, tool] of calls) {
      if (lateCalls <= lateCallLimit) break
      if (tool.closed) { calls.delete(id); lateCalls-- }
    }
    for (const done of finished) rounds.delete(done)
    messages.clear()
    if (!finished.includes(turn) || incomplete === undefined) return
    if (unresolved) return 'Claude Code ended the turn before a tool returned its result.'
    if (failed) {
      const detail = failed.exitCode === undefined ? '' : ' with exit code ' + failed.exitCode
      return 'Claude Code ended the turn after a tool failed' + detail + '.'
    }
    return 'Claude Code ended the turn after a tool call without continuing the reply.'
  }

  function stream(update, parentId) {
    if (update?.type === 'message_start') {
      messages.set(parentId, { id: update.message?.id, text: new Map() })
      return
    }
    const block = update?.type === 'content_block_start' ? update.content_block : undefined
    if (block?.type === 'tool_use') {
      reportTool(block, parentId, true, messages.get(parentId)?.id)
      return
    }
    const text = block?.type === 'text' ? block.text : update?.delta?.type === 'text_delta' ? update.delta.text : undefined
    const pending = messages.get(parentId)
    if (typeof pending?.id !== 'string' || typeof text !== 'string' || !text) return
    pending.text.set(update.index, (pending.text.get(update.index) ?? '') + text)
    session.emit({ type: 'text', text, textKey: textKey(parentId, pending.id, update.index) })
  }

  function finishBlock(block, index, pending, multiBlock, parentId, messageId) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      // A single-block frame does not include the block's original index.
      const sent = multiBlock && pending?.has(index) ? [index, pending.get(index)]
        : pending && [...pending].find(([, value]) => block.text.startsWith(value))
      const length = sent && block.text.startsWith(sent[1]) ? sent[1].length : 0
      if (length) pending.delete(sent[0])
      const text = block.text.slice(length)
      if (text) session.emit({ type: 'text', text, textKey: textKey(parentId, messageId, length ? sent[0] : index) })
    } else if (block?.type === 'thinking' && block.thinking) session.emit({ type: 'thought', text: block.thinking })
    else if (block?.type === 'tool_use') reportTool(block, parentId, false, messageId)
  }

  session.onLine = line => {
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event?.type === 'control_response' && onControl?.(event.response)) return
    const parentId = event?.parent_tool_use_id ?? undefined
    const delivery = usageDelivery?.()
    if (event?.type === 'stream_event') {
      if (!delivery) stream(event.event, parentId)
      return
    }
    const content = event?.message?.content
    // A failed API call's synthetic message ("Failed to authenticate: ...") is the
    // turn's failure, which the transport reports; its text is not the reply.
    if (event?.type === 'assistant' && typeof event.error === 'string' && event.error !== '') {
      receive(line)
      return
    }
    if (event?.type === 'assistant' && Array.isArray(content)) {
      const report = delivery && claudeUsageFrame(event)
      if (report) delivery.report = report
      // Let the underlying transport retain usage and control state. The
      // timeline owns the visible blocks so a streamed block is emitted once.
      receive(JSON.stringify({ ...event, message: { ...event.message, content: [] } }))
      const turnId = session.turns.owner()
      if (!delivery && parentId === undefined && turnId !== undefined && (event.message.stop_reason === 'end_turn' ||
        content.some(block => block?.type === 'tool_use' || (block?.type === 'text' && block.text?.trim()))))
        roundOf(turnId, event.message.id)
      const current = messages.get(parentId)
      const pending = current?.id === event.message.id ? current?.text : undefined
      content.forEach((block, index) => finishBlock(block, index, pending, content.length > 1, parentId, event.message.id))
      return
    }
    if (event?.type === 'user' && Array.isArray(content)) {
      const results = content.filter(block => block?.type === 'tool_result')
      const details = results.length === 1 ? event.tool_use_result : undefined
      for (const block of results) {
        const tool = calls.get(block.tool_use_id)
        if (!tool) continue
        const { status, output, exitCode } = claudeToolResult(block, details, tool.name)
        tool.status = status
        tool.exitCode = exitCode
        const durationMs = Number.isFinite(details?.durationMs) && details.durationMs >= 0 ? details.durationMs : Date.now() - tool.startedAt
        if (status !== 'completed' || tool.closed) note('Claude Code returned a tool result', {
          nativeEvent: 'tool-result', nativeTurnId: diagnosticToken(tool.turnId), toolId: diagnosticToken(tool.id),
          toolName: diagnosticToken(tool.name), outcome: status, exitCode, elapsedMs: durationMs,
          requestedTimeoutMs: tool.requestedTimeoutMs, late: tool.closed === true,
          timedOut: typeof details?.timedOut === 'boolean' ? details.timedOut : undefined,
          signal: diagnosticToken(details?.signal),
        })
        const path = details?.filePath ?? tool.filePath
        const changes = Array.isArray(details?.structuredPatch) ? [{ path, hunks: details.structuredPatch }] : undefined
        session.emit({ type: 'execution-trace', turnId: tool.turnId, ...(tool.closed ? { late: true } : {}),
          trace: { type: 'tool', id: block.tool_use_id, name: tool.name, status, output, exitCode, changes, durationMs } })
        if (tool.closed) calls.delete(tool.id)
      }
      // The native transport also consumes user echoes for acknowledgements.
      if (results.length) {
        receive(JSON.stringify({ ...event, tool_use_result: undefined, message: {
          ...event.message, content: content.filter(block => block?.type !== 'tool_result'),
        } }))
        return
      }
    }
    receive(line)
  }
}
