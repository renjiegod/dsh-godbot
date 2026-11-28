import { chmodSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dshShellOutcome, dshShellToolNames } from '../../drivers/dsh-tool-receipt.js'
import { readAntigravityToolResult } from './antigravity-tool-result.js'
import { readClaudeExecutionHistory } from './claude-execution-history.js'
import { bindToolSlots, mirroredTools, readToolActivity, toolSlots } from './shared/tool-timeline.js'
import { skillNameFromPath, toolKind } from './shared/tool-kind.js'
import { commandLabel } from './tool-activity.js'
import { turnOutcome } from './shared/turn-outcome.js'
import { interruptedAttemptContent, withInterruptedAttempts } from './mobile-tool-timeline.js'
import { isBotGoalSource } from './core/constants.js'

const fieldLimit = 256 * 1024
const turnPageSize = 12
const legacyReceiptWindowMs = 5_000
const pendingClaudeShell = row => row.type === 'tool' && ['Bash', 'PowerShell'].includes(row.name) &&
  row.id?.startsWith('toolu_') && row.parentId === undefined && ['running', 'pending'].includes(row.status)
const toolDetails = ['input', 'output', 'changes', 'error']
const persistedFields = ['name', 'activityKind', 'status', 'text', 'layout', 'cwd', 'exitCode', 'durationMs', 'locations', 'parentId', ...toolDetails]
// A legacy DSH shell result can carry its only exit marker in the output body.
// All the markers end with ], so only those rows need the full output here.
const toolListsSql = `
  SELECT wanted.value AS turn, saved.turn IS NOT NULL AS saved, event.seq,
    CASE WHEN json_type(event.data, '$.output') IS 'array'
      AND json_extract(event.data, '$.name') IN (${dshShellToolNames.map(name => `'${name}'`).join(', ')})
      AND (json_type(event.data, '$.exitCode') IS NOT 'integer'
        OR json_extract(event.data, '$.exitCode') NOT BETWEEN ${Number.MIN_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER})
      AND substr(CAST(json_extract(event.data, '$.output[0].text') AS BLOB), -1) = x'5D'
      THEN event.data
      ELSE json_remove(event.data, '$.output', '$.changes', '$.error')
    END AS preview,
    (${toolDetails.map(field => `json_type(event.data, '$.${field}') IS NOT NULL`).join(' OR ')}) AS has_detail
  FROM json_each(?) AS wanted
  LEFT JOIN execution_turns AS saved ON saved.part=? AND saved.turn=wanted.value
  LEFT JOIN execution_events AS event ON event.part=? AND event.turn=wanted.value AND event.identity LIKE 'tool:%'
  ORDER BY wanted.value, event.seq
`
const now = () => new Date().toISOString()
const eventTime = event => Number.isFinite(event.time) ? new Date(event.time).toISOString() : now()
const chronological = (a, b) => b.startedAt.localeCompare(a.startedAt) || (b.nativeOrder ?? 0) - (a.nativeOrder ?? 0) || String(b.turn).localeCompare(String(a.turn))
const textBlocks = content => typeof content === 'string' ? content : !Array.isArray(content) ? '' :
  content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n')

function redact(value, clean) {
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map(item => redact(item, clean))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, clean)]))
  return value
}

function protect(rt, row) {
  // A secret broker result itself is never a useful tool receipt for display.
  if (/(?:^|__)request_secret$/u.test(row.name ?? '')) delete row.output
  if (rt.redactSecrets) {
    for (const key of ['name', 'text', 'layout', 'cwd', 'locations', ...toolDetails]) {
      if (row[key] !== undefined) row[key] = redact(row[key], value => rt.redactSecrets(value))
    }
  }
  return row
}

function limitField(value) {
  if (typeof value === 'string') return [value.slice(0, fieldLimit), value.length > fieldLimit]
  const json = JSON.stringify(value)
  return json?.length > fieldLimit ? [json.slice(0, fieldLimit), true] : [value, false]
}

function mergeEvent(previous, next) {
  const row = { ...previous, type: next.type }
  const truncated = new Set(previous?.truncatedFields)
  if (next.type === 'tool') row.id = next.id
  for (const field of persistedFields) {
    if (next[field] === undefined) continue
    const [value, shortened] = limitField(next[field])
    row[field] = value
    if (shortened) truncated.add(field)
    else truncated.delete(field)
  }
  if (typeof next.outputDelta === 'string' && next.output === undefined) {
    const [output, shortened] = limitField((typeof row.output === 'string' ? row.output : '') + next.outputDelta)
    row.output = output
    if (shortened) truncated.add('output')
  }
  if (row.type === 'tool') {
    // Inspect the complete shell result before the retention limit cuts its tail.
    Object.assign(row, dshShellOutcome(row.name, row.status, next.output ?? row.output, next.shellExitCode ?? row.exitCode))
  }
  if (truncated.size) row.truncatedFields = Array.from(truncated)
  else delete row.truncatedFields
  return row
}

// What a call works on, from its input, for a summary that leaves the input out, named
// the way the chat names a call from its arguments: a DSH tool's arguments come as JSON
// text, a CLI's command as plain text, of which only the program shows.
function inputTarget(row) {
  let value = row.input
  if (typeof value === 'string' && value.trimStart().startsWith('{')) {
    try { value = JSON.parse(value) } catch { /* plain text */ }
  }
  let target
  if (typeof value === 'string') target = commandLabel(value)
  else if (value !== null && typeof value === 'object') {
    const arg = key => (typeof value[key] === 'string' && value[key].trim() !== '' ? value[key] : undefined)
    const path = arg('file_path') ?? arg('path')
    target = (row.activityKind ?? toolKind(row.name, path)) === 'skill'
      ? arg('name') ?? arg('skill') ?? skillNameFromPath(path)
      : arg('description') ?? path ?? arg('pattern') ?? arg('query') ?? commandLabel(arg('command') ?? arg('cmd'))
  }
  return typeof target === 'string' ? target.replace(/\s+/g, ' ').trim().slice(0, 240) || undefined : undefined
}

// `target` stands apart from `text`: the chat lays a call's summary over the name it
// read from the call itself, and a guess from the input must not replace that name.
function summary(row) {
  return row.type === 'tool' ? toolPreview(row, toolDetails.some(key => row[key] !== undefined)) : row
}

function toolPreview(row, detailAvailable) {
  const preview = { ...row, detailAvailable }
  if ((typeof preview.text !== 'string' || preview.text === '') && !Array.isArray(preview.locations)) {
    const target = inputTarget(row)
    if (target) preview.target = target
  }
  for (const key of toolDetails) delete preview[key]
  return preview
}

function identity(event) {
  if (event.type === 'tool') return typeof event.id === 'string' && event.id.length > 0 ? 'tool:' + event.id : undefined
  if (['text', 'input', 'error'].includes(event.type) && Number.isSafeInteger(event.seq)) return 'message:' + event.seq
}

function assistantEvent(content, seq) {
  const layout = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text)
        layout.push({ type: 'text', text: block.text })
      else if (block?.type === 'tool-call' && typeof block.id === 'string')
        layout.push({ type: 'host-tool', id: block.id })
      else if (block?.type === 'reasoning' && typeof block.text === 'string') {
        for (const line of block.text.split('\n')) {
          const activity = readToolActivity(line)
          if (activity) layout.push({ type: 'activity', ...activity })
        }
      }
    }
  }
  if (layout.some(item => item.type !== 'text') && JSON.stringify(layout).length <= fieldLimit)
    return { type: 'text', seq, layout }
  const text = textBlocks(content)
  return text ? { type: 'text', seq, text, layout: [] } : undefined
}

function turnEvent(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'assistant/message':
      return assistantEvent(data.message?.content, event.seq)
    case 'user/message': {
      const source = data.source ?? data.message?.source
      if (source?.kind !== 'user' && !(source?.kind === 'bot' && source.role === 'request' && !source.handoff)) return
      const text = textBlocks(data.content ?? data.message?.content)
      return text ? { type: 'input', text, seq: event.seq } : undefined
    }
    case 'tool/call':
    case 'tool/ptc-dispatch-start':
      return {
        type: 'tool', id: data.subCallId ?? data.callId, name: data.name, status: 'running',
        input: data.arguments, parentId: data.subCallId ? data.callId : undefined,
      }
    case 'tool/result': {
      const message = data.message
      return {
        type: 'tool', id: message?.toolCallId ?? data.callId,
        status: message?.isError || message?.ok === false ? 'failed' : 'completed', output: message?.content,
        shellExitCode: data.meta?.exitCode,
      }
    }
    case 'tool/ptc-dispatch':
      return {
        type: 'tool', id: data.subCallId, name: data.name, parentId: data.callId, input: data.arguments,
        status: data.isError ? 'failed' : 'completed', output: data.content, shellExitCode: data.meta?.exitCode,
      }
    case 'turn/end': {
      const reason = data.reason
      return reason?.kind === 'error' || reason?.kind === 'failed' ? {
        type: 'error', text: reason.error?.message ?? reason.message ?? '执行失败', seq: event.seq,
      } : undefined
    }
  }
}

export class ExecutionHistory {
  constructor(rt, { readClaude = readClaudeExecutionHistory, readAntigravity = readAntigravityToolResult } = {}) {
    this.rt = rt
    this.readClaude = readClaude
    this.readAntigravity = readAntigravity
    this.active = new Map()
    this.attempts = new Map()
    this.nativeCache = new Map()
  }

  // The Bot whose work a Session holds: its own chat and its parts, and its Session in
  // a group, which the group's member work panel reads. A group's own Session runs no
  // model and belongs to no Bot.
  ownerOf(sessionId) {
    const rt = this.rt
    if (rt.roomOwners?.has(sessionId)) return undefined
    const member = rt.groupOwners?.get(sessionId)
    if (member !== undefined) return typeof member?.botId === 'string' ? member.botId : undefined
    const past = rt.pastOwners?.get(sessionId)
    return rt.chatOwners?.get(sessionId) ?? past?.botId
  }

  database() {
    if (this.db) return this.db
    const path = join(this.rt.home, 'execution.sqlite')
    mkdirSync(this.rt.home, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      db.exec(`PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS execution_turns (
          part TEXT NOT NULL, turn INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
          PRIMARY KEY(part, turn)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS execution_events (
          seq INTEGER PRIMARY KEY, part TEXT NOT NULL, turn INTEGER NOT NULL, identity TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(part, turn, identity)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS execution_by_turn ON execution_events(part, turn, seq);
        CREATE TABLE IF NOT EXISTS execution_restarts (
          part TEXT NOT NULL, turn INTEGER NOT NULL, checkpoint TEXT NOT NULL,
          resumed_turn INTEGER, needs_retry INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(part, turn)
        ) STRICT;`)
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
    return db
  }

  close() {
    this.closed = true
    this.db?.close()
    this.db = undefined
    this.nativeCache.clear()
    this.attempts.clear()
  }

  observe(sessionId, event) {
    if (this.closed || !this.ownerOf(sessionId)) return
    const turn = event.data?.turn ?? this.active.get(sessionId)
    if (!Number.isSafeInteger(turn)) return
    if (event.type === 'turn/start') {
      this.attempts.delete(sessionId)
      this.active.set(sessionId, turn)
      this.tryWrite(db => db.prepare('INSERT OR IGNORE INTO execution_turns(part, turn, started_at) VALUES (?, ?, ?)').run(sessionId, turn, eventTime(event)))
      return
    }
    if (event.type === 'user/message') this.observeRestartContinuation(sessionId, turn, event.data?.source)
    if (event.type === 'turn/end') {
      const outcome = turnOutcome(event.data?.reason)?.status
      const attempt = this.attempts.get(sessionId)
      this.attempts.delete(sessionId)
      if (outcome === 'interrupted' && attempt?.data?.turn === turn) {
        const partial = assistantEvent(interruptedAttemptContent(attempt), attempt.seq)
        if (partial) this.record(sessionId, partial, turn)
      }
      const item = turnEvent(event)
      if (item) this.record(sessionId, item, turn)
      if (this.active.get(sessionId) === turn) this.active.delete(sessionId)
      this.tryWrite(db => {
        db.prepare('UPDATE execution_turns SET ended_at=? WHERE part=? AND turn=?').run(eventTime(event), sessionId, turn)
        if (['stopped', 'interrupted', 'failed'].includes(outcome)) {
          db.prepare(`UPDATE execution_events SET data=json_set(data, '$.status', 'interrupted') WHERE part=? AND turn=?
            AND json_extract(data, '$.status') IN ('running','pending')`).run(sessionId, turn)
        }
      })
      return
    }
    if (event.type === 'assistant/attempt' && Array.isArray(event.data?.stream)) this.attempts.set(sessionId, event)
    else if (event.type === 'assistant/message') this.attempts.delete(sessionId)
    const item = turnEvent(event)
    if (item) this.record(sessionId, item, turn)
  }

  recordUpdateRestart(restart, work) {
    const affected = work.filter(item => item.kind === 'turn' && Number.isSafeInteger(item.turn) && this.ownerOf(item.sessionId))
    if (affected.length === 0) return
    const db = this.database()
    const latestTool = db.prepare(`SELECT json_extract(data, '$.id') AS id, json_extract(data, '$.name') AS name,
      json_extract(data, '$.status') AS status, json_extract(data, '$.exitCode') AS exitCode
      FROM execution_events WHERE part=? AND turn=? AND identity LIKE 'tool:%'
        AND json_extract(data, '$.status') IN ('completed','failed','interrupted','declined')
      ORDER BY coalesce(json_extract(data, '$.receivedAt'), 0) DESC, seq DESC LIMIT 1`)
    const write = db.prepare(`INSERT INTO execution_restarts(part, turn, checkpoint, needs_retry) VALUES (?, ?, ?, ?)
      ON CONFLICT(part, turn) DO UPDATE SET checkpoint=excluded.checkpoint, needs_retry=excluded.needs_retry`)
    const checkpoints = affected.map(({ sessionId, turn }) => {
      const lastTool = latestTool.get(sessionId, turn)
      const context = this.rt.restartTurnContext(sessionId, turn)
      const { questionReplies, goalId } = context ?? {}
      const managed = this.rt.inboxOwnsTurn?.(sessionId, turn) || this.rt.runningBotGoal?.(sessionId)
      return { sessionId, turn, needsRetry: context === undefined && !managed, checkpoint: {
        restartId: restart.id, source: 'web', mode: restart.mode, boot: restart.boot,
        ...restart.target, at: Date.now(),
        nativeSessionId: this.rt.state.localAgents?.sessions?.[sessionId]?.cliSessionId,
        questionReplies, goalId, lastTool,
      } }
    })
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const { sessionId, turn, needsRetry, checkpoint } of checkpoints) {
        write.run(sessionId, turn, JSON.stringify(checkpoint), Number(needsRetry))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    for (const { sessionId, turn, checkpoint } of checkpoints) this.rt.noteFailure({
      source: 'update', level: 'info', text: 'Godbot saved a turn before restarting DSH', cause: 'update-restart',
      restartId: restart.id, sessionId, turn, nativeSessionId: checkpoint.nativeSessionId,
      toolId: checkpoint.lastTool?.id, toolName: checkpoint.lastTool?.name,
    })
  }

  restartCheckpoint(sessionId, turn) {
    if (this.closed || !this.ownerOf(sessionId) || !Number.isSafeInteger(turn)) return undefined
    const row = this.database().prepare('SELECT checkpoint FROM execution_restarts WHERE part=? AND turn=?').get(sessionId, turn)
    return row && JSON.parse(row.checkpoint)
  }

  restartStatus(sessionId, turn, botId) {
    if (this.closed || typeof sessionId !== 'string' || !Number.isSafeInteger(turn) || !this.ownerOf(sessionId)
      || botId !== undefined && this.ownerOf(sessionId) !== botId) return undefined
    const row = this.database().prepare('SELECT resumed_turn, needs_retry FROM execution_restarts WHERE part=? AND turn=?').get(sessionId, turn)
    if (!row) return undefined
    if (row.resumed_turn !== null) return { phase: 'resumed', turn: row.resumed_turn }
    return { phase: row.needs_retry === 1 ? 'retry' : 'waiting' }
  }

  markRestartNeedsRetry(sessionId, turn) {
    if (this.closed || !this.ownerOf(sessionId) || !Number.isSafeInteger(turn)) return
    this.tryWrite(db => {
      const result = db.prepare('UPDATE execution_restarts SET needs_retry=1 WHERE part=? AND turn=? AND resumed_turn IS NULL AND needs_retry=0')
        .run(sessionId, turn)
      if (result.changes > 0) this.rt.chatTimelineChanged?.(sessionId, turn)
    })
  }

  observeRestartContinuation(sessionId, turn, source) {
    const prefix = sessionId + ':'
    const plain = typeof source?.resumeOf === 'string' && source.resumeOf.startsWith(prefix)
      ? Number(source.resumeOf.slice(prefix.length)) : undefined
    if (plain === undefined && source?.restartOfTurn === undefined && !isBotGoalSource(source)) return
    this.tryWrite(db => {
      const original = plain ?? source.restartOfTurn ?? (typeof source.goalId === 'string'
        ? db.prepare(`SELECT turn FROM execution_restarts WHERE part=? AND turn<? AND resumed_turn IS NULL AND needs_retry=0
            AND json_extract(checkpoint, '$.goalId')=? ORDER BY turn DESC LIMIT 1`).get(sessionId, turn, source.goalId)?.turn
        : undefined)
      if (!Number.isSafeInteger(original) || original >= turn) return
      const result = db.prepare('UPDATE execution_restarts SET resumed_turn=? WHERE part=? AND turn=? AND resumed_turn IS NULL')
        .run(turn, sessionId, original)
      if (result.changes > 0) this.rt.chatTimelineChanged?.(sessionId, original)
    })
  }

  tryWrite(write) {
    try { write(this.database()) } catch (error) {
      if (!this.loggedWriteFailure) {
        this.loggedWriteFailure = true
        this.rt.ctx?.logger?.warn('Could not save Godbot execution history: %s', error?.code ?? 'write failed')
      }
    }
  }

  recordLateTool(sessionId, event) {
    if (this.closed || !this.ownerOf(sessionId) || event.type !== 'tool') return
    const key = identity(event)
    if (!key) return
    this.tryWrite(db => {
      const rows = db.prepare('SELECT turn FROM execution_events WHERE part=? AND identity=? LIMIT 2').all(sessionId, key)
      if (rows.length === 1) this.record(sessionId, event, rows[0].turn)
    })
  }

  // Older adapters could close the DSH turn as completed before Claude wrote a
  // shell termination receipt. Require the same tool id in the bound transcript
  // and a receipt at the close boundary, with no subsequent assistant reply.
  async recoverClaudeInterruption(sessionId, turn) {
    if (this.closed || !this.ownerOf(sessionId) || !Number.isSafeInteger(turn) ||
        this.rt.state.localAgents?.sessions?.[sessionId]?.route !== 'local-claude-code') return
    const db = this.database()
    const ended = db.prepare('SELECT ended_at FROM execution_turns WHERE part=? AND turn=?').get(sessionId, turn)?.ended_at
    if (!ended) return
    const pending = new Set(db.prepare("SELECT data FROM execution_events WHERE part=? AND turn=? AND identity LIKE 'tool:%'").all(sessionId, turn)
      .map(row => JSON.parse(row.data)).filter(pendingClaudeShell).map(row => row.id))
    if (pending.size === 0) return
    const endedAt = Date.parse(ended)
    for (const native of await this.nativeTurns(sessionId)) {
      const receipt = native.events.findLast(row => row.type === 'tool' && pending.has(row.id) &&
        (row.status === 'interrupted' || row.status === 'failed' && row.exitCode >= 128) &&
        Math.abs(Date.parse(row.receivedAt) - endedAt) <= legacyReceiptWindowMs)
      if (receipt && !native.events.some(row => row.type === 'text' && row.seq > receipt.seq && row.text?.trim()))
        return { ...receipt, recoveredInterruption: true }
    }
  }

  record(sessionId, event, turn = this.active.get(sessionId) ?? this.rt.live?.get(sessionId)?.turn) {
    if (this.closed || !Number.isSafeInteger(turn) || !this.ownerOf(sessionId) || !event) return
    const key = identity(event)
    if (!key) return
    this.tryWrite(db => {
      const prior = db.prepare('SELECT data FROM execution_events WHERE part=? AND turn=? AND identity=?').get(sessionId, turn, key)
      const previous = prior && JSON.parse(prior.data)
      const row = protect(this.rt, mergeEvent(previous, event))
      if (row.type === 'tool') {
        if (['completed', 'failed', 'interrupted', 'declined'].includes(event.status)) row.receivedAt = Date.now()
        else if (previous?.receivedAt !== undefined) row.receivedAt = previous.receivedAt
      }
      db.prepare('INSERT OR IGNORE INTO execution_turns(part, turn, started_at) VALUES (?, ?, ?)').run(sessionId, turn, now())
      db.prepare(`INSERT INTO execution_events(part, turn, identity, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(part, turn, identity) DO UPDATE SET data=excluded.data`).run(sessionId, turn, key, JSON.stringify(row))
      if (event.type === 'tool') this.rt.chatTimelineChanged?.(sessionId, turn)
    })
  }

  // Chat pages refresh during streaming. Select only the fields that fit on
  // a card; file contents and shell output are read when the card is opened.
  toolSummaries(sessionId, turn) {
    if (this.closed || !this.ownerOf(sessionId)) return []
    const db = this.database()
    this.summaryQuery ??= db.prepare(`SELECT json_extract(data,'$.id') AS id, json_extract(data,'$.name') AS name,
      substr(coalesce(json_extract(data,'$.locations[0].path'), nullif(json_extract(data,'$.text'),''),
        json_extract(data,'$.input.file_path'), json_extract(data,'$.input.path')),1,400) AS text,
      json_extract(data,'$.status') AS status
      FROM execution_events WHERE part=? AND turn=? AND identity LIKE 'tool:%' ORDER BY seq`)
    return this.summaryQuery.all(sessionId, turn).map(row =>
      Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)))
  }

  nativeTurns(sessionId) {
    const binding = this.rt.state.localAgents?.sessions?.[sessionId]
    if (!binding?.cwd || !binding.cliSessionId || !['local-claude-code', 'local-codex-cli'].includes(binding.route)) return Promise.resolve([])
    const key = JSON.stringify([sessionId, binding.route, binding.cwd, binding.cliSessionId])
    const cached = this.nativeCache.get(key)
    if (cached && cached.until > Date.now()) return cached.promise
    const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(binding.cwd, process.env.CLAUDE_CONFIG_DIR) : undefined
    const promise = Promise.resolve().then(() => binding.route === 'local-codex-cli'
      ? this.rt.readCodexExecutionHistory?.(binding) ?? []
      : this.readClaude({ cwd: binding.cwd, nativeId: binding.cliSessionId, configDir })).catch(() => [])
    this.nativeCache.delete(key)
    this.nativeCache.set(key, { until: Date.now() + 10_000, promise })
    if (this.nativeCache.size > 4) this.nativeCache.delete(this.nativeCache.keys().next().value)
    return promise
  }

  storedEvents(db, sessionId, turn, toolId, onlyTools) {
    const selected = typeof toolId === 'string'
      ? db.prepare('SELECT seq, data, identity FROM execution_events WHERE part=? AND turn=? AND identity=?').all(sessionId, turn, 'tool:' + toolId)
      : db.prepare(`SELECT seq, data, identity FROM execution_events WHERE part=? AND turn=?
          ${onlyTools ? "AND identity LIKE 'tool:%'" : ''} ORDER BY seq`).all(sessionId, turn)
    return selected.map(({ seq, data, identity }) => {
      const row = JSON.parse(data)
      // Older rows may already have the native shell marker but lack the exit code.
      return { seq, ...row, ...dshShellOutcome(row.name, row.status, row.output, row.exitCode),
        ...(row.type === 'text' && row.layout === undefined ? { messageSeq: Number(identity.slice('message:'.length)) } : {}) }
    })
  }

  turnRunning(sessionId, turn) {
    return this.active.get(sessionId) === turn || this.rt.live?.get(sessionId)?.turn === turn
  }

  async readToolLists(sessionId, turns, assertAllowed) {
    const db = this.database()
    this.toolListsQuery ??= db.prepare(toolListsSql)
    const lists = new Map(turns.map(turn => [turn, { events: [], running: this.turnRunning(sessionId, turn), saved: false }]))
    for (const { turn, saved, seq, preview, has_detail } of
      this.toolListsQuery.all(JSON.stringify(turns), sessionId, sessionId)) {
      const list = lists.get(turn)
      list.saved = Boolean(saved)
      if (seq === null) continue
      const row = { seq, ...JSON.parse(preview) }
      if (row.type !== 'tool') continue
      Object.assign(row, dshShellOutcome(row.name, row.status, row.output, row.exitCode))
      list.events.push(toolPreview(row, Boolean(has_detail)))
    }
    const isClaude = this.rt.state.localAgents?.sessions?.[sessionId]?.route === 'local-claude-code'
    const byTurn = {}
    for (const [turn, { events, running, saved }] of lists) {
      // Unindexed DSH history and legacy Claude interruptions use the normal
      // history path, which checks the conversation again after reading its log.
      byTurn[turn] = !running && (!saved || isClaude && events.some(pendingClaudeShell))
        ? await this.readNumberedTurn(sessionId, turn, { onlyTools: true, assertAllowed })
        : { events, running }
    }
    assertAllowed()
    return byTurn
  }

  // DSH retains the original call/result bodies for its own tools, including
  // archived parts created before the execution database existed.
  async sessionTurns(sessionId, target) {
    const controller = this.rt.ctx?.sessionController
    if (!controller?.page) return []
    const signal = AbortSignal.timeout(3500)
    const records = []
    let beforeSeq
    try {
      for (let pageNo = 0; pageNo < (target === undefined ? 2 : 12); pageNo++) {
        const page = await controller.page({ address: { kind: 'session', sessionId }, beforeSeq, maxMessages: 80 }, signal)
        const events = page.records.map(record => record.event)
        if (events.length === 0) break
        records.unshift(...events)
        if (!page.hasMore || events.some(event => event.type === 'turn/start' && event.data?.turn <= target)) break
        beforeSeq = events[0].seq
      }
    } catch {
      return []
    }
    const turns = []
    let current
    for (const event of withInterruptedAttempts(records)) {
      if (event.type === 'turn/start') {
        current = { turn: event.data.turn, startedAt: eventTime(event), events: [] }
        if (target === undefined || current.turn === target) turns.push(current)
        else current = undefined
      } else if (current && (event.data?.turn === undefined || event.data.turn === current.turn)) {
        const row = turnEvent(event)
        if (row) current.events.push({ ...row, seq: event.seq })
        if (event.type === 'turn/end') {
          current.endedAt = eventTime(event)
          current = undefined
        }
      }
    }
    return turns
  }

  async readNumberedTurn(sessionId, turn, { toolId, onlyTools, assertAllowed }) {
    assertAllowed()
    const db = this.database()
    const running = this.turnRunning(sessionId, turn)
    let events = this.storedEvents(db, sessionId, turn, toolId, onlyTools)
    const recovered = !running && events.some(pendingClaudeShell) ? await this.recoverClaudeInterruption(sessionId, turn) : undefined
    assertAllowed()
    if (recovered) events = events.map(row => row.id === recovered.id
      ? { ...protect(this.rt, mergeEvent(row, recovered)), recoveredInterruption: true } : row)
    if (!running && !db.prepare('SELECT 1 FROM execution_turns WHERE part=? AND turn=?').get(sessionId, turn)) {
      const prior = (await this.sessionTurns(sessionId, turn))[0]
      const native = prior ? matchNative(prior, await this.nativeTurns(sessionId)) : undefined
      assertAllowed()
      events = mergeRows(this.rt, native?.events ?? prior?.events ?? [], toolId)
    } else if (!onlyTools && !running && events.some(row => row.messageSeq !== undefined) && events.some(row => row.type === 'tool')) {
      const prior = (await this.sessionTurns(sessionId, turn))[0]
      assertAllowed()
      const layouts = new Map(prior?.events.filter(row => row.layout?.length).map(row => [row.seq, row.layout]))
      events = events.map(row => layouts.has(row.messageSeq) ? protect(this.rt, mergeEvent(row, {
        type: 'text', layout: layouts.get(row.messageSeq),
      })) : row)
    }
    const tool = toolId !== undefined && events[0]
    if (tool && (tool.output == null || (tool.status === 'failed' && tool.error == null))) {
      const binding = this.rt.state.localAgents?.sessions?.[sessionId]
      const native = this.readAntigravity(binding, tool)
      if (native) events[0] = protect(this.rt, mergeEvent(tool, {
        type: 'tool', id: tool.id, output: tool.output ?? native.output, error: tool.error ?? native.error,
      }))
    }
    return { events: toolId !== undefined ? events : onlyTools
      ? events.filter(row => row.type === 'tool').map(summary)
      : orderedRows(events).map(summary), running }
  }

  async read({ botId, sessionId, turn, turns: several, toolId, beforeTurn, onlyTools } = {}) {
    const assertAllowed = () => {
      if (this.closed || typeof botId !== 'string' || typeof sessionId !== 'string' ||
          !this.rt.botOf(botId) || this.ownerOf(sessionId) !== botId) {
        throw new Error('请选择该 Bot 的私聊或历史会话。')
      }
    }
    // The chat batches the tool lists of its visible turns into one request.
    if (onlyTools === true && toolId === undefined) {
      if (Array.isArray(several)) {
        const turns = [...new Set(several.filter(Number.isSafeInteger).slice(0, 200))]
        if (turns.length === 0) return { byTurn: {} }
        assertAllowed()
        return { byTurn: await this.readToolLists(sessionId, turns, assertAllowed) }
      }
      if (Number.isSafeInteger(turn)) {
        assertAllowed()
        return (await this.readToolLists(sessionId, [turn], assertAllowed))[turn]
      }
    }
    assertAllowed()
    if (toolId !== undefined && (turn === undefined || typeof toolId !== 'string' || toolId.length > 400)) throw new Error('工具调用无效。')
    if (Number.isSafeInteger(turn)) return this.readNumberedTurn(sessionId, turn, { toolId, onlyTools, assertAllowed })
    const db = this.database()
    const native = await this.nativeTurns(sessionId)
    assertAllowed()
    if (typeof turn === 'string') {
      const selected = native.find(row => 'native:' + row.nativeTurnId === turn)
      const events = mergeRows(this.rt, selected?.events ?? [], toolId)
      return { events: toolId === undefined ? events.map(summary) : events, running: false }
    }
    if (turn !== undefined) throw new Error('回合编号无效。')
    const stored = db.prepare('SELECT turn, started_at AS startedAt, ended_at AS endedAt FROM execution_turns WHERE part=? ORDER BY turn DESC').all(sessionId)
    const storedTurns = new Set(stored.map(row => row.turn))
    const old = (await this.sessionTurns(sessionId)).filter(row => !storedTurns.has(row.turn) && row.events.length)
    assertAllowed()
    const ids = new Set(db.prepare("SELECT identity FROM execution_events WHERE part=? AND identity LIKE 'tool:%'").all(sessionId).map(row => row.identity))
    const recentReports = db.prepare(`SELECT turn, data FROM execution_events WHERE part=?
      AND json_extract(data,'$.type')='text' ORDER BY seq DESC LIMIT 100`).all(sessionId)
    const reportTimes = new Map(stored.map(row => [row.turn, row.startedAt]))
    const knownReports = recentReports.map(row => ({ startedAt: reportTimes.get(row.turn), events: [JSON.parse(row.data)] }))
    const matchedNative = new Set([...old, ...knownReports].map(row => matchNative(row, native)).filter(Boolean))
    const nativeOnly = native.filter(row => !matchedNative.has(row) && !row.events.some(item => item.type === 'tool' && ids.has(identity(item))))
    const turns = stored.map(row => ({ ...row, running: this.active.get(sessionId) === row.turn }))
      .concat(old.map(({ turn, startedAt, endedAt }) => ({ turn, startedAt, endedAt, running: false })))
      .concat(nativeOnly.map((row, nativeOrder) => ({ turn: 'native:' + row.nativeTurnId, startedAt: row.startedAt ?? '', endedAt: row.endedAt,
        nativeOrder, native: true, running: false })))
      .sort(chronological)
    const previous = turns.findIndex(row => row.turn === beforeTurn)
    if (beforeTurn !== undefined && previous < 0) return { turns: [], cursor: null }
    const at = previous + 1
    const page = turns.slice(at, at + turnPageSize)
    return { turns: page, cursor: at + page.length < turns.length ? page.at(-1).turn : null }
  }
}

function matchNative(dshTurn, nativeTurns) {
  const text = dshTurn.events.filter(event => event.type === 'text').map(event => event.text ??
    (Array.isArray(event.layout) ? event.layout.findLast(part => part.type === 'text')?.text : undefined))
    .findLast(text => typeof text === 'string' && text.trim())?.trim()
  if (!text) return
  const timestamp = Date.parse(dshTurn.startedAt)
  const timeWindow = text.length >= 80 ? 5 * 60_000 : 20_000
  const matches = nativeTurns.filter(turn => Math.abs(Date.parse(turn.startedAt) - timestamp) < timeWindow &&
    turn.events.some(event => event.type === 'text' && event.text.trim() === text))
  if (matches.length === 1) return matches[0]
}

function orderedRows(events) {
  const tools = events.filter(row => row.type === 'tool')
  const byId = new Map(tools.map(row => [row.id, row]))
  const hostIds = new Set()
  const entries = []
  for (const row of events) {
    if (!Array.isArray(row.layout)) continue
    row.layout.forEach((part, index) => {
      if (part.type === 'host-tool') hostIds.add(part.id)
      if (part.type === 'activity') entries.push([`${row.seq}:${index}`, part])
    })
  }
  const mirrors = mirroredTools(tools, hostIds)
  const slots = bindToolSlots(toolSlots(entries), tools, hostIds, mirrors)
  const placed = new Set([...hostIds, ...mirrors, ...Array.from(slots.values(), slot => slot.id).filter(Boolean)])
  const seen = new Set()
  return events.flatMap(row => {
    if (row.type === 'tool' && placed.has(row.id)) return []
    if (!Array.isArray(row.layout) || !row.layout.length) return row
    return row.layout.flatMap((part, index) => {
      const seq = `${row.seq}:${index}`
      if (part.type === 'text') return { type: 'text', text: part.text, seq }
      const tool = part.type === 'host-tool' ? byId.get(part.id) : slots.get(seq)
      if (!tool || (tool.id && seen.has(tool.id))) return []
      if (tool.id) seen.add(tool.id)
      return { ...tool, type: 'tool', seq }
    })
  })
}

function mergeRows(rt, events, toolId) {
  const rows = new Map()
  for (const event of events) {
    if (toolId !== undefined && (event.type !== 'tool' || event.id !== toolId)) continue
    const key = identity(event)
    if (!key) continue
    const prior = rows.get(key)
    rows.set(key, protect(rt, { seq: prior?.seq ?? event.seq, ...mergeEvent(prior, event) }))
  }
  return Array.from(rows.values())
}

export function install(rt) {
  const history = rt.executionHistory = new ExecutionHistory(rt)
  rt.ctx.on('session/event', (session, event) => history.observe(session.id, event))
  rt.ctx.effect(() => () => history.close(), 'Godbot Bot execution history')
}
