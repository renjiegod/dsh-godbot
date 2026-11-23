import { claudeUsageFrame } from '../drivers/external/claude-usage-data.js'
import { claudeToolResult } from '../drivers/external/tool-results.js'
import { commandLabel, toolActivity } from './team-runtime/tool-activity.js'

// Stream-json emits each content block in order, then repeats its complete
// value in one or more assistant frames (often one frame per block).
export function attachClaudeBotTimeline(session, { cwd, onControl, usageDelivery } = {}) {
  const receive = session.onLine.bind(session)
  const messages = new Map()
  const calls = new Map()
  const textKey = (parentId, messageId, index) => JSON.stringify([parentId, messageId, index])

  function reportTool(block, parentId, partial) {
    if (block.name?.startsWith('mcp__godbot__')) return // The host records this call.
    const { id, name, input } = block
    const target = input?.file_path ?? input?.path ?? input?.description ?? commandLabel(input?.command)
    if (typeof id !== 'string' || !id) {
      if (!partial) session.emit(toolActivity(name, target, 'started'))
      return
    }
    const known = calls.get(id)
    if (partial && known) return
    const trace = { type: 'tool', id, name, cwd, parentId, text: target,
      ...(!partial ? { input } : {}), ...(!known ? { status: 'running' } : {}) }
    calls.set(id, { name, filePath: input?.file_path ?? known?.filePath })
    session.emit({ ...(known ? { type: 'execution-trace' } : toolActivity(name, target, 'started')), trace })
  }

  function stream(update, parentId) {
    if (update?.type === 'message_start') {
      messages.set(parentId, { id: update.message?.id, text: new Map() })
      return
    }
    const block = update?.type === 'content_block_start' ? update.content_block : undefined
    if (block?.type === 'tool_use') {
      reportTool(block, parentId, true)
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
    else if (block?.type === 'tool_use') reportTool(block, parentId, false)
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
        const { status, output, exitCode } = claudeToolResult(block, details)
        const path = details?.filePath ?? tool.filePath
        const changes = Array.isArray(details?.structuredPatch) ? [{ path, hunks: details.structuredPatch }] : undefined
        session.emit({ type: 'execution-trace', trace: { type: 'tool', id: block.tool_use_id, name: tool.name,
          status, output, exitCode, changes,
          durationMs: Number.isFinite(details?.durationMs) && details.durationMs >= 0 ? details.durationMs : undefined } })
      }
      // The native transport also consumes user echoes for acknowledgements.
      if (results.length) {
        receive(JSON.stringify({ ...event, tool_use_result: undefined, message: {
          ...event.message, content: content.filter(block => block?.type !== 'tool_result'),
        } }))
        return
      }
    }
    if (event?.type === 'result') {
      messages.clear()
      calls.clear()
    }
    receive(line)
  }
}
