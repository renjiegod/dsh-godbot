import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { claudeCounts, projectClaudeModels } from '../drivers/external/claude-usage-data.js'

const maxBytes = 4 * 1024 * 1024

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return
  const epoch = Date.parse(value)
  if (Number.isFinite(epoch) && new Date(epoch).toISOString().startsWith(value)) return value
}

function project(cache) {
  if (cache?.version !== 5) return { available: false, reason: 'unsupported' }
  const asOf = date(cache.lastComputedDate)
  if (!asOf) return { available: false, reason: 'unreadable' }
  const totals = claudeCounts(cache, { sessions: 'totalSessions', messages: 'totalMessages' })
  const daily = []
  const days = new Set()
  if (Array.isArray(cache.dailyActivity)) {
    for (const row of cache.dailyActivity) {
      const day = date(row?.date)
      if (!day || day > asOf) continue
      const values = claudeCounts(row, { messages: 'messageCount', sessions: 'sessionCount', toolCalls: 'toolCallCount' })
      if (!Object.keys(values).length) continue
      if (days.has(day)) return { available: false, reason: 'unreadable' }
      days.add(day)
      daily.push({ date: day, ...values })
    }
    daily.sort((a, b) => a.date.localeCompare(b.date))
  }
  const models = projectClaudeModels(cache.modelUsage)
  const longest = claudeCounts(cache.longestSession, { durationMs: 'duration', messages: 'messageCount' })
  const firstSessionDate = date(typeof cache.firstSessionDate === 'string' ? cache.firstSessionDate.slice(0, 10) : undefined)
  if (!Object.values(totals).some(n => n > 0) && !daily.length && !models.length && !Object.values(longest).some(n => n > 0))
    return { available: false, reason: 'empty' }
  return {
    available: true, asOf, totals, daily, models,
    ...(Object.keys(longest).length ? { longest } : {}),
    ...(firstSessionDate && firstSessionDate <= asOf ? { firstSessionDate } : {}),
  }
}

// Read only Claude's finished daily aggregation. No Claude process, history scan,
// credentials or mutable settings are involved. The caller resolves configDir
// from the Bot's trusted launch configuration, never from the browser.
export async function readClaudeStats({ configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') } = {}) {
  if (typeof configDir !== 'string' || !isAbsolute(configDir)) return { available: false, reason: 'unreadable' }
  let file
  try {
    const path = join(configDir, 'stats-cache.json')
    const entry = await lstat(path)
    if (!entry.isFile()) return { available: false, reason: 'unreadable' }
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > maxBytes) return { available: false, reason: 'unreadable' }
    if (stat.size === 0) return { available: false, reason: 'empty' }
    // Bound reading even if a concurrent writer changes the file size after stat.
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) return { available: false, reason: 'unreadable' }
      offset += bytesRead
    }
    return project(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    return { available: false, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' }
  } finally {
    await file?.close()
  }
}
