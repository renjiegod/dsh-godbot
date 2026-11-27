import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { botWorkspaceId } from './bot-task-workspace.js'
import { accessOf, cardId, installBoardIndex, publicCard, queryBoard } from './work-board-index.js'
import { sourceSummary, sourceDetail } from './work-board-sources.js'
import { ownConversations } from './team-runtime/core/threads.js'

const denied = () => Object.assign(new Error('工作项不存在或无法访问。'), { code: 'bot/not-found' })
const stale = () => Object.assign(new Error('工作项或交付证据已更新，请刷新后重新确认。'), { code: 'bot/refused' })
const textField = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '')
const fingerprint = (value) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      ),
    )
    .digest('hex')
function parseId(id) {
  if (!/^GB-[1-9][0-9]{0,14}$/.test(String(id))) throw denied()
  return Number(String(id).slice(3))
}
function queryStatements(db) {
  return {
    boardLastMessage: db.prepare(
      "SELECT json_extract(data,'$.createdAt') AS at FROM records WHERE collection='messages' AND json_extract(data,'$.taskId')=? ORDER BY seq DESC LIMIT 1",
    ),
    boardMessages: db.prepare(
      "SELECT seq,data FROM records WHERE collection='messages' AND json_extract(data,'$.taskId')=? AND seq<? ORDER BY seq DESC LIMIT 41",
    ),
    boardRunEvents: db.prepare(
      "SELECT seq,data FROM records WHERE collection='fullTeamEvidence' AND json_extract(data,'$.runId')=? AND seq<? ORDER BY seq DESC LIMIT 41",
    ),
    boardRunTime: db.prepare(
      "SELECT json_extract(data,'$.createdAt') AS at FROM records WHERE collection='fullTeamEvidence' AND json_extract(data,'$.runId')=? ORDER BY seq DESC LIMIT 1",
    ),
    boardParties: db.prepare(
      "SELECT DISTINCT json_extract(data,'$.to[0]') AS recipient, json_extract(data,'$.from') AS sender FROM records WHERE collection='messages' AND json_extract(data,'$.taskId')=?",
    ),
  }
}
function checkedRow(db, rt, req) {
  const row =
    req.taskId && !req.id
      ? db.prepare("SELECT * FROM board_cards WHERE kind='task' AND scope='' AND source_id=?").get(req.taskId)
      : db.prepare('SELECT * FROM board_cards WHERE number=?').get(parseId(req.id))
  if (!row?.summary) throw denied()
  const { allowed } = accessOf(rt)
  if (JSON.parse(row.summary).refs.some((ref) => !allowed.has(ref))) throw denied()
  return row
}
function detailFor(service, db, req, readOnly) {
  const row = checkedRow(db, service.runtime, req)
  const before = Number.isSafeInteger(req.before) && req.before > 0 ? req.before : Number.MAX_SAFE_INTEGER
  const item = sourceDetail(service, row, JSON.parse(row.meta), publicCard(row), before)
  item.dependencies = item.dependencies.flatMap((taskId) => {
    try {
      const dependency = checkedRow(db, service.runtime, { taskId })
      return [{ id: cardId(dependency.number), title: JSON.parse(dependency.summary).title }]
    } catch {
      return []
    }
  })
  if (readOnly) item.actions = []
  return { ...item, readOnly }
}
export function readBoardOnly(dir, rt, endpoint, req = {}) {
  if (endpoint === 'board-action') throw new Error('当前宿主为只读。')
  const path = join(dir, 'godbot.sqlite3')
  if (!existsSync(path)) throw new Error('等待拥有此工作区的宿主初始化看板。')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='board_cards'").get())
      throw new Error('请先在拥有工作区的宿主打开新版工作看板。')
    if (endpoint === 'board-view') return queryBoard(db, accessOf(rt), req, true)
    const byKey = db.prepare('SELECT data FROM records WHERE collection=? AND id=?')
    const byRun = db.prepare(
      "SELECT data FROM records WHERE collection=? AND json_extract(data,'$.runId')=? ORDER BY seq",
    )
    const get = (c, id) => (typeof id === 'string' ? JSON.parse(byKey.get(c, id)?.data ?? 'null') : null)
    const store = {
      get,
      require: (c, id) =>
        get(c, id) ??
        (() => {
          throw denied()
        })(),
      forRun: (c, id) => byRun.all(c, id).map((r) => JSON.parse(r.data)),
    }
    return detailFor({ store, runtime: rt, ...queryStatements(db) }, db, req, true)
  } finally {
    db.close()
  }
}

export class WorkBoard {
  constructor(service) {
    this.service = service
    this.rt = service.runtime
    this.store = service.store
    this.db = service.database.db
    installBoardIndex(this.db)
    Object.assign(service, queryStatements(this.db))
    this.source = this.db.prepare('SELECT * FROM board_cards WHERE kind=? AND scope=? AND source_id=?')
    this.byNumber = this.db.prepare('SELECT * FROM board_cards WHERE number=?')
    this.insert = this.db.prepare(
      'INSERT INTO board_cards(kind,scope,source_id,meta,origin_key) VALUES(?,?,?,?,?)',
    )
    this.update = this.db.prepare('UPDATE board_cards SET summary=? WHERE number=?')
    this.roomsDirty = true
    this.roomKeys = new Map()
    this.roomVersions = new Map()
    this.liveKeys = new Set()
    this.off = this.rt.onSaved?.(() => {
      this.roomsDirty = true
      this.schedule()
    })
    this.rt.workBoardLive = () => this.schedule()
    service.database.boardChanged = () => this.schedule()
    this.schedule()
  }
  schedule() {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.closed && !this.rt.readOnly()) {
        try {
          this.sync()
        } catch (error) {
          this.rt.ctx?.logger?.warn?.('Work board refresh: %s', error.message)
        }
      }
    }, 75)
    this.timer.unref?.()
  }
  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.off?.()
    delete this.rt.workBoardLive
    this.service.database.boardChanged = undefined
  }
  ensure(kind, scope, id) {
    let row = this.source.get(kind, scope, id)
    if (!row) {
      const n = this.insert.run(kind, scope, id, '{}', null).lastInsertRowid
      row = this.byNumber.get(n)
    }
    return row
  }
  project(row) {
    const next = sourceSummary(this.service, row, JSON.parse(row.meta))
    const json = next ? JSON.stringify(next) : null
    if (json === row.summary) return false
    this.update.run(json, row.number)
    return true
  }
  changed() {
    this.db.exec('UPDATE board_version SET revision=revision+1 WHERE id=1')
    if (!this.notify) {
      this.notify = true
      queueMicrotask(() => {
        this.notify = false
        if (!this.closed) this.rt.publishFeed?.('work-board', {})
      })
    }
  }
  sync() {
    if (this.closed || this.rt.readOnly()) return
    let changed = false
    const queue = this.db.prepare('SELECT kind,source_id FROM board_dirty LIMIT 250')
    const clear = this.db.prepare('DELETE FROM board_dirty WHERE kind=? AND source_id=?')
    const rows = queue.all()
    if (rows.length) {
      this.store.transaction(() => {
        for (const { kind, source_id: id } of rows) {
          const row = this.ensure(kind, '', id)
          if (this.project(row)) changed = true
          clear.run(kind, id)
        }
        if (changed) this.changed()
      })
      changed = false
    }
    if (this.roomsDirty) {
      this.roomsDirty = false
      const next = new Map(this.roomKeys),
        versions = new Map()
      this.store.transaction(() => {
        for (const room of Object.values(this.rt.state.rooms ?? {})) {
          versions.set(room.id, { revision: room.workBoardTasksRevision ?? 0, tasks: room.tasks })
          const prior = this.roomVersions.get(room.id)
          if (prior && prior.tasks === room.tasks && prior.revision === (room.workBoardTasksRevision ?? 0))
            continue
          for (const t of Object.values(room.tasks ?? {})) {
            const key = JSON.stringify([room.id, t.id]),
              stamp = JSON.stringify([t.status, t.updatedAt, t.notes?.length, t.progress, t.result, t.reason])
            next.set(key, stamp)
            if (this.roomKeys.get(key) !== stamp && this.project(this.ensure('room', room.id, t.id)))
              changed = true
          }
        }
        const old = this.roomsIndexed
          ? this.roomKeys.keys()
          : this.db
              .prepare("SELECT scope,source_id FROM board_cards WHERE kind='room' AND summary IS NOT NULL")
              .all()
              .map((r) => JSON.stringify([r.scope, r.source_id]))
        for (const key of old) {
          const [scope, id] = JSON.parse(key)
          if (this.rt.state.rooms?.[scope]?.tasks?.[id]) continue
          next.delete(key)
          const row = this.source.get('room', scope, id)
          if (row?.summary) {
            this.update.run(null, row.number)
            changed = true
          }
        }
        if (changed) this.changed()
      })
      this.roomKeys = next
      this.roomVersions = versions
      this.roomsIndexed = true
      changed = false
    }
    const active = new Set()
    for (const id of this.service.botTasks.active.values()) {
      const delivery = this.store.get('botTaskDeliveries', id)
      if (delivery?.taskId) active.add(delivery.taskId)
    }
    // Pending questions outlive some turns. Refresh their projections when the answer clears.
    for (const id of new Set([...this.liveKeys, ...active])) {
      const row = this.source.get('task', '', id)
      if (row && this.project(row)) changed = true
    }
    this.liveKeys = active
    for (const row of this.db
      .prepare(
        "SELECT * FROM board_cards WHERE kind='run' AND json_extract(summary,'$.phase') IN ('doing','review','attention')",
      )
      .all()) {
      if (this.project(row)) changed = true
    }
    if (changed) this.changed()
    if (rows.length === 250) {
      this.schedule()
      return true
    }
    return false
  }
  async warm() {
    // Yield between migration pages so old workspaces can still receive Bot and phone events.
    while (this.sync()) await nextTick()
    if (this.closed) throw new Error('工作区已关闭。')
  }
  async view(req) {
    await this.warm()
    return queryBoard(this.db, accessOf(this.rt), req, !!this.rt.readOnly())
  }
  async item(req) {
    await this.warm()
    return detailFor(this.service, this.db, req, !!this.rt.readOnly())
  }
  origin(input, access) {
    if (!input) return null
    const { sessionId, botId, roomId } = input
    if (Boolean(botId) === Boolean(roomId)) throw denied()
    if (botId) {
      const bot = access.bots.find((b) => b.id === botId)
      if (
        !bot ||
        typeof sessionId !== 'string' ||
        !(this.rt.chatOf(botId) === sessionId || ownConversations(bot).some((c) => c.parts.includes(sessionId)))
      )
        throw denied()
    } else {
      const room = access.rooms.find((r) => r.id === roomId)
      if (!room) throw denied()
      if (
        sessionId &&
        sessionId !== roomId &&
        sessionId !== this.rt.sessionOfRoom?.(room) &&
        sessionId !== room.sessionId &&
        !(room.parts ?? []).some((p) => (p.sessionId ?? p) === sessionId) &&
        this.rt.pastOwners?.get(sessionId)?.roomId !== roomId
      )
        throw denied()
    }
    const messageId = textField(input.messageId, 256)
    if (!messageId) throw new Error('缺少原消息定位。')
    return {
      botId: botId || undefined,
      roomId: roomId || undefined,
      sessionId: sessionId || roomId,
      messageId,
      ...(Number.isSafeInteger(input.turnId) ? { turnId: input.turnId } : {}),
    }
  }
  checkOwner(owner, access) {
    if (owner && !access.bots.some((b) => b.id === owner)) throw denied()
  }
  async action(req) {
    if (this.closed || this.rt.readOnly()) throw new Error('当前工作区为只读。')
    const requestId = textField(req.requestId, 180)
    if (!requestId || requestId !== req.requestId) throw new Error('操作需要有效的请求编号。')
    await this.warm()
    if (this.rt.readOnly()) throw new Error('当前工作区为只读。')
    const digest = fingerprint(req)
    const previous = this.db.prepare('SELECT * FROM board_requests WHERE id=?').get(requestId)
    if (previous) {
      if (previous.fingerprint !== digest) throw new Error('请求编号已用于另一项操作。')
      const item = await this.item({ id: cardId(previous.number) })
      if (!previous.outcome) throw new Error('上次操作已接收，送达结果待核对。请查看原记录。')
      return item
    }
    const access = accessOf(this.rt)
    let row = req.op === 'create' ? null : checkedRow(this.db, this.rt, req)
    if (row && (typeof req.version !== 'string' || req.version !== JSON.parse(row.summary).version)) throw stale()
    const op = req.op
    const external = op === 'note' || op === 'cancel' || row?.kind === 'run'
    const recordRequest = (number, outcome) =>
      this.db.prepare('INSERT INTO board_requests VALUES(?,?,?,?)').run(requestId, digest, number, outcome)
    if (external) {
      if (!row) throw denied()
      const detail = detailFor(this.service, this.db, { id: cardId(row.number) }, false)
      if (!detail.actions.includes(op)) throw stale()
      if (op === 'note' && !textField(req.text, 500)) throw new Error('请填写留言。')
      if (
        row.kind === 'run' &&
        (!textField(req.text, 8000) ||
          !detail.children.some(
            (c) => c.id === req.childId && c.status === 'reported' && c.evidenceRevision === req.evidenceRevision,
          ))
      )
        throw stale()
      recordRequest(row.number, null)
      let noteSaved = false
      try {
        if (row.kind === 'run') {
          await this.service.automation.full.review(
            {
              teamId: botWorkspaceId,
              runId: row.source_id,
              taskId: req.childId,
              revision: req.evidenceRevision,
              decision: op === 'approve' ? 'accept' : 'rework',
              evidence: req.text,
            },
            () => this.db.prepare("UPDATE board_requests SET outcome='ok' WHERE id=?").run(requestId),
          )
        } else if (op === 'note') {
          const result = this.rt.taskNote(row.scope, row.source_id, req.text)
          if (result.error) throw new Error(result.error)
          const note = result.task.notes.at(-1)
          note.requestId = requestId
          noteSaved = true
          await this.rt.save({ required: true })
          const bot = this.rt.botOf(result.task.botId)
          if (!bot || !accessOf(this.rt).allowed.has('room/' + row.scope)) throw denied()
          await this.rt.sendUser({
            sessionId: row.scope,
            requestId: 'work-board/' + requestId,
            content: [{ type: 'text', text: '@' + bot.name + ' ' + note.text }],
          })
          note.delivered = true
          await this.rt.save({ required: true })
        } else {
          const result = this.rt.taskCancel(row.scope, row.source_id)
          if (result.error) throw new Error(result.error)
          await this.rt.save({ required: true })
        }
        this.db.prepare("UPDATE board_requests SET outcome='ok' WHERE id=?").run(requestId)
      } catch (error) {
        // A full-team review writes its receipt in its own transaction. Once a
        // group note has reached the send boundary its delivery needs reconciliation.
        if (!noteSaved) this.db.prepare('DELETE FROM board_requests WHERE id=? AND outcome IS NULL').run(requestId)
        throw error
      } finally {
        this.roomsDirty = true
        this.sync()
      }
    } else
      this.store.transaction(() => {
        if (op === 'create') {
          const title = textField(req.title, 160)
          if (!title) throw new Error('请填写工作项标题。')
          this.checkOwner(req.owner, access)
          if (req.room && !access.allowed.has('room/' + req.room)) throw denied()
          const origin = this.origin(req.origin, access)
          const key = origin
            ? JSON.stringify([origin.roomId || origin.botId, origin.sessionId, origin.messageId])
            : null
          const existing = key && this.db.prepare('SELECT number FROM board_cards WHERE origin_key=?').get(key)
          if (existing) row = checkedRow(this.db, this.rt, { id: cardId(existing.number) })
          else {
            const meta = {
              title,
              criteria: textField(req.criteria, 8000),
              owner: req.owner || null,
              room: req.room || origin?.roomId || null,
              origin,
              priority: req.priority === 1 ? 1 : 0,
              version: 1,
              updated: Date.now(),
            }
            const result = this.insert.run('draft', '', randomUUID(), JSON.stringify(meta), key)
            row = this.byNumber.get(result.lastInsertRowid)
          }
        } else if (row.kind === 'draft') {
          const meta = JSON.parse(row.meta)
          if (meta.archived || !['edit', 'archive', 'dispatch'].includes(op)) throw stale()
          if (req.owner !== undefined) {
            this.checkOwner(req.owner, access)
            meta.owner = req.owner || null
          }
          if (req.criteria !== undefined) meta.criteria = textField(req.criteria, 8000)
          if (req.title !== undefined) {
            meta.title = textField(req.title, 160)
            if (!meta.title) throw new Error('请填写工作项标题。')
          }
          if (req.priority !== undefined) meta.priority = req.priority === 1 ? 1 : 0
          meta.updated = Date.now()
          meta.version++
          if (op === 'archive') meta.archived = true
          if (op === 'dispatch') {
            const task = this.service.botTasks.apply({
              action: 'task.create',
              teamId: botWorkspaceId,
              title: meta.title,
              criteria: meta.criteria,
              ownerId: meta.owner,
              boardNumber: row.number,
              boardOrigin: meta.origin,
            })
            this.db
              .prepare("UPDATE board_cards SET kind='task',source_id=? WHERE number=?")
              .run(task.id, row.number)
          }
          this.db.prepare('UPDATE board_cards SET meta=? WHERE number=?').run(JSON.stringify(meta), row.number)
        } else {
          const card = publicCard(row),
            detail = sourceDetail(this.service, row, JSON.parse(row.meta), card)
          if (!detail.actions.includes(op)) throw stale()
          const request = {
            teamId: botWorkspaceId,
            taskId: row.source_id,
            expectedRevision: detail.revision,
            expectedEvidenceRevision: detail.evidenceRevision,
          }
          if (op === 'approve' || op === 'reject') {
            if (req.evidenceRevision !== detail.evidenceRevision) throw stale()
            this.service.botTasks.apply({
              ...request,
              action: 'task.review',
              approve: op === 'approve',
              evidence: textField(req.text, 8000),
            })
          } else if (op === 'retry') this.service.botTasks.apply({ ...request, action: 'task.retry' })
          else if (op === 'transfer') {
            this.checkOwner(req.owner, access)
            this.service.botTasks.apply({ ...request, action: 'task.transfer', ownerId: req.owner })
          } else throw stale()
        }
        recordRequest(row.number, 'ok')
        this.project(this.byNumber.get(row.number))
        this.changed()
      })
    return this.item({ id: cardId(row.number) })
  }
}
