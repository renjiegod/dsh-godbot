import { createInterface } from 'node:readline'
import { projectClaudeSessionUsage } from '../drivers/external/claude-usage-data.js'
import { openClaudeTranscript } from './claude-transcript.js'

const maxBytes = 24 * 1024 * 1024
const timeWindow = 15_000

// A caller first binds the owner-visible message to its historical CLI session.
// Only its exact local-command stdout record can supply the missing snapshot.
export async function readHistoricalClaudeUsage({ configDir, cwd, nativeId, text, time } = {}) {
  if (typeof text !== 'string' || !text || text.length > 256 * 1024) return null
  const at = typeof time === 'number' ? time : typeof time === 'string' ? Date.parse(time) : NaN
  if (!Number.isFinite(at)) return null
  const transcript = await openClaudeTranscript({ configDir, cwd, nativeId }, maxBytes)
  if (!transcript) return null
  const { file, stat, dirs } = transcript
  try {
    const stdout = '<local-command-stdout>' + text + '</local-command-stdout>'
    let seen = false
    let result = null
    const stream = file.createReadStream({ start: 0, end: stat.size - 1, encoding: 'utf8', autoClose: false })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.includes('"local_command"') || !line.includes('"commandRun"')) continue
        if (line.length > 2 * 1024 * 1024) return null
        let row
        try { row = JSON.parse(line) } catch { return null }
        if (row?.type !== 'system' || row.subtype !== 'local_command' || row.isSidechain === true ||
            row.sessionId !== nativeId || typeof row.cwd !== 'string' || !dirs.has(row.cwd.normalize('NFC')) ||
            row.commandRun?.command !== 'usage' || row.content !== stdout) continue
        const stamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
        if (!Number.isFinite(stamp) || Math.abs(stamp - at) > timeWindow) continue
        if (seen) return null
        seen = true
        result = projectClaudeSessionUsage(row.usageReport)
      }
      const after = await file.stat()
      return after.size === stat.size && after.mtimeMs === stat.mtimeMs ? result : null
    } finally {
      lines.close()
      stream.destroy()
    }
  } catch {
    return null
  } finally {
    await file?.close().catch(() => {})
  }
}
