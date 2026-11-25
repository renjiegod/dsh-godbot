import { createInterface } from 'node:readline'
import { isAbsolute } from 'node:path'
import { claudeToolResult } from '../../drivers/external/tool-results.js'
import { openClaudeTranscript } from '../claude-transcript.js'

const maxBytes = 64 * 1024 * 1024
const maxLine = 8 * 1024 * 1024
const roles = new Set(['system', 'user', 'assistant'])

function inputText(content) {
  if (typeof content === 'string') return content
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n')
}

function toolResult(block, metadata, tool) {
  const { status, output, exitCode } = claudeToolResult(block, metadata, tool.name)
  const path = metadata?.filePath ?? tool.input?.file_path
  const hunks = metadata?.structuredPatch
  return {
    type: 'tool', id: block.tool_use_id, name: tool.name,
    status,
    ...(output === undefined ? {} : { output }),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(Number.isFinite(metadata?.durationMs) && metadata.durationMs >= 0 ? { durationMs: metadata.durationMs } : {}),
    ...(typeof path === 'string' && Array.isArray(hunks) && hunks.length ? {
      changes: [{ path, hunks }],
    } : {}),
  }
}

// Per-Bot authorization comes from the caller's native session binding. This
// reads Claude's saved conversation in place, without resuming the CLI.
export async function readClaudeExecutionHistory({ cwd, nativeId, configDir } = {}) {
  const transcript = await openClaudeTranscript({ cwd, nativeId, configDir }, maxBytes)
  if (!transcript) return []
  const { file, stat } = transcript
  const turns = []
  const seen = new Set()
  const calls = new Map()
  let current, lastAt, seq = 0
  const append = (turn, event, timestamp) => {
    turn.events.push({ ...event, seq: ++seq })
    if (turn === current) lastAt = timestamp
  }
  const stream = file.createReadStream({ start: 0, end: stat.size - 1, encoding: 'utf8', autoClose: false })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line || line.length > maxLine) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      // Claude writes duplicate message rows during replay and bookkeeping rows
      // for internal context. Only actual main-session messages and end markers
      // belong on the Bot timeline.
      // A session can change its cwd mid-turn. The original project path and
      // native UUID already constrain which file and whose records we read.
      if (!roles.has(row?.type) || row.sessionId !== nativeId || typeof row.cwd !== 'string' ||
          !isAbsolute(row.cwd) || row.isSidechain || row.isMeta || row.isCompactSummary) continue
      if (typeof row.uuid !== 'string' || !row.uuid || seen.has(row.uuid)) continue
      const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
      if (!Number.isFinite(time)) continue
      const at = new Date(time).toISOString()
      seen.add(row.uuid)
      const content = row.message?.content ?? []
      if (row.type === 'user') {
        const results = Array.isArray(content) ? content.filter(block => block?.type === 'tool_result') : []
        if (results.length) {
          const metadata = results.length === 1 ? row.toolUseResult : undefined
          for (const block of results) {
            const call = calls.get(block.tool_use_id)
            if (!call || call.settled) continue
            call.settled = true
            append(call.turn, { ...toolResult(block, metadata, call.tool), receivedAt: at }, at)
          }
          continue
        }
        const text = typeof content === 'string' || Array.isArray(content) ? inputText(content) : ''
        const hasImage = Array.isArray(content) && content.some(block => block?.type === 'image')
        if (!text && !hasImage) continue
        if (current && current.endedAt === undefined) current.endedAt = lastAt
        current = { nativeTurnId: row.uuid, startedAt: at, events: [] }
        turns.push(current)
        append(current, { type: 'input', text: text || '[Image]' }, at)
      } else if (current && row.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text)
            append(current, { type: 'text', text: block.text }, at)
          if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !block.id ||
              typeof block.name !== 'string' || calls.has(block.id)) continue
          const parentId = row.parent_tool_use_id
          const tool = { type: 'tool', id: block.id, name: block.name, status: 'running',
            cwd: row.cwd, input: block.input, ...(typeof parentId === 'string' ? { parentId } : {}) }
          calls.set(block.id, { turn: current, tool })
          append(current, tool, at)
        }
        if (row.message?.stop_reason === 'end_turn') current.endedAt = at
      } else if (current && row.type === 'system' && row.subtype === 'turn_duration') {
        current.endedAt = at
      }
    }
    const after = await file.stat()
    // An append is safe because the stream used the initial byte boundary. A
    // rewrite or truncation can mix generations and cannot prove a past turn.
    return after.size > stat.size || (after.size === stat.size && after.mtimeMs === stat.mtimeMs) ? turns : []
  } catch {
    return []
  } finally {
    lines.close()
    stream.destroy()
    await file.close().catch(() => {})
  }
}
