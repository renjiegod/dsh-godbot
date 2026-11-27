import { randomUUID } from 'node:crypto'
import { commentLength, commentPlan, commentReactions } from '../team/work-board-discussion-format.js'
import { runOrigin } from './run-origin.js'
import { commentBody, BoardCommentStore, absentComment, changedComment, installCommentStore } from './work-board-comment-store.js'
import { conversationHead } from './team-runtime/core/threads.js'
import { runningBoardWork } from './work-board-runs.js'
import { accessOf, cardId } from './work-board-index.js'

const workPrefix = 'board-comment/'
const runningStates = new Set(['sending', 'sent', 'running', 'waiting', 'unknown'])
const matchingWork = (id) => typeof id === 'string' && id.startsWith(workPrefix)

export function boardCommentTargets(rt, card) {
  const access = accessOf(rt)
  const room = card.room && access.rooms.find(room => room.id === card.room)
  const bots = card.room ? access.bots.filter(bot => room?.members.includes(bot.id)) : access.bots
  return new Map(bots.map(bot => [bot.id, bot]))
}

function assignee(card, allowed) {
  return card.source !== 'draft' && !['done', 'history'].includes(card.phase) && allowed.has(card.owner)
    ? card.owner : null
}

export function readDiscussion(db, rt, checked, endpoint, req, readOnly) {
  const card = JSON.parse(checked.summary)
  const allowed = boardCommentTargets(rt, card)
  const store = new BoardCommentStore(db)
  if (endpoint === 'board-artifacts') return { artifacts: store.artifacts(checked.number, allowed) }
  if (endpoint === 'board-comment-file') {
    if (req.snapshot === true) return store.snapshotFile('snapshot/' + checked.number, String(req.fileId ?? ''))
    return store.file(checked.number, req, allowed)
  }
  return {
    ...store.list(checked.number, req, allowed),
    bots: [...allowed.values()].map(bot => ({ id: bot.id, name: bot.name })),
    assignee: assignee(card, allowed),
    readOnly,
  }

}

export class WorkBoardDiscussion {
  constructor(board, checkedRow, fingerprint) {
    this.board = board
    this.db = board.db
    this.rt = board.rt
    this.checked = (req) => checkedRow(this.db, this.rt, req)
    this.fingerprint = fingerprint
    installCommentStore(this.db)
    this.store = new BoardCommentStore(this.db)
    this.run = this.db.prepare('SELECT * FROM board_comment_runs WHERE id=?')
    this.pending = this.db.prepare("SELECT id,number,bot_id FROM board_comment_runs WHERE state='queued' ORDER BY created,rowid LIMIT 24")
    // A durable DSH inbox or resumed turn may still answer an interrupted send.
    // The outbox only delivers entries that never began a send.
    this.db.exec("UPDATE board_comment_runs SET state='unknown' WHERE state IN ('sending','sent','running','waiting')")
    this.enqueue = this.db.prepare(`INSERT INTO board_comment_runs
      (id,number,comment_id,bot_id,state,created,mode,bound_id,bound_turn,retry_of)
      VALUES(?,?,?,?,'queued',?,?,?,?,?)`)
    this.opening = new Map()
    this.sending = new Set()
    this.schedule()
  }

  writable() {
    if (this.board.closed || this.rt.readOnly()) throw new Error('当前工作区为只读。')
  }

  changed(number) {
    this.rt.publishFeed?.('work-board-discussion', { id: cardId(number) })
  }

  async read(endpoint, req) {
    await this.board.warm()
    const row = this.checked(req)
    const result = readDiscussion(this.db, this.rt, row, endpoint, req, !!this.rt.readOnly())
    return endpoint === 'board-discussion' ? { ...result, activeRuns: this.board.runs.active(row) } : result
  }

  async action(req) {
    this.writable()
    await this.board.warm()
    this.writable()
    const row = this.checked({ id: req.id })
    if (typeof req.requestId !== 'string' || !/^[\w-]{1,180}$/.test(req.requestId))
      throw new Error('操作需要有效的请求编号。')
    const { requestId, op } = req
    const digest = this.fingerprint(req)
    const prior = this.db.prepare('SELECT * FROM board_comment_requests WHERE id=?').get(requestId)
    if (prior) {
      if (prior.number !== row.number || prior.fingerprint !== digest)
        throw new Error('请求编号已用于另一项操作。')
      return { commentId: prior.comment_id }
    }
    const card = JSON.parse(row.summary)
    const allowed = boardCommentTargets(this.rt, card)
    const { store } = this
    let id = req.commentId
    this.board.store.transaction(() => {
      if (op === 'post' || op === 'edit') {
        const current = op === 'edit' ? store.require(row.number, id) : null
        if (current && (current.botId || current.deleted)) throw absentComment()
        if (current && req.expectedRevision !== current.revision) throw changedComment()
        const parentId = current ? current.parentId : req.parentId
        const original = parentId ? store.require(row.number, parentId) : null
        const root = original ? store.require(row.number, original.rootId) : null
        const parent = original?.botId && !allowed.has(original.botId) ? { deleted: true } : original
        if (!current && parent?.deleted) throw absentComment()
        const body = commentBody(req.body)
        const plan = commentPlan(body, [...allowed.values()], {
          parent, root, assignee: assignee(card, allowed), quiet: req.quiet === true, editing: !!current,
        })
        // Editing can notify a newly addressed Bot but never reruns a Bot
        // already asked by this comment.
        const runs = current ? store.runs.all(id) : []
        const send = plan.ids.filter(botId => !runs.some(run => run.bot_id === botId))
        if (send.length > 8) throw new Error('一条评论最多可唤醒 8 个 Bot。')
        if (req.targets != null && (!Array.isArray(req.targets) ||
          JSON.stringify([...req.targets].sort()) !== JSON.stringify([...send].sort()))) throw changedComment()
        const data = {
          body,
          mentions: plan.mentions,
          unmatched: plan.unmatched,
          quiet: req.quiet === true,
          continuation: current?.continuation ?? (send.length === 1 ? send[0] : null),
          annotations: req.annotations === undefined ? current?.annotations : this.annotations(row, allowed, req.annotations),
        }
        if (current) {
          store.update(current, { ...data, revision: current.revision + 1, editedAt: Date.now() })
          const cancel = this.db.prepare("UPDATE board_comment_runs SET state='cancelled' WHERE id=? AND state='queued'")
          for (const run of runs) {
            if (req.quiet === true || (current.mentions?.includes(run.bot_id) && !plan.mentions.includes(run.bot_id)))
              cancel.run(run.id)
          }
        } else {
          id = store.insert(row.number, original, data)
        }
        store.attach(id, req.files, req.keepFiles)
        if (!body && !store.files.get(id) && !data.annotations?.length) throw new Error('请填写评论或附加文件。')
        const active = req.modes ? this.board.runs.active(row) : {}
        for (const botId of send) {
          const mode = req.modes?.[botId]
          if (mode?.mode === 'note') continue
          if (mode && !['queue', 'steer', 'restart'].includes(mode.mode)) throw changedComment()
          if (mode && mode.mode !== 'queue') {
            const binding = active[botId]
            if (!binding || binding.runId !== mode.runId || binding.turnId !== mode.turnId) throw changedComment()
            if (mode.mode === 'steer' && (!binding.steer || store.files.get(id))) {
              throw new Error('只可将纯文字插入支持插话的运行。')
            }
          }
          this.enqueue.run(workPrefix + randomUUID(), row.number, id, botId, Date.now(),
            mode?.mode ?? 'queue', mode?.runId ?? null, mode?.turnId ?? null, null)
        }
      } else {
        const current = store.require(row.number, id)
        if (current.botId && !allowed.has(current.botId)) throw absentComment()
        if (op === 'delete') {
          if (current.botId || current.deleted) throw absentComment()
          if (req.expectedRevision !== current.revision) throw changedComment()
          store.update(current, { deleted: true, body: '', mentions: [], reactions: [], revision: current.revision + 1 })
          store.removeFiles(id)
          this.db.prepare("UPDATE board_comment_runs SET state='cancelled' WHERE comment_id=? AND state='queued'").run(id)
        } else if (op === 'react') {
          if (current.deleted || !commentReactions.includes(req.emoji) || typeof req.active !== 'boolean') throw absentComment()
          const reactions = new Set(current.reactions ?? [])
          if (req.active) reactions.add(req.emoji)
          else reactions.delete(req.emoji)
          store.update(current, { reactions: [...reactions] })
        } else if (op === 'resolve') {
          if (current.parentId || typeof req.resolved !== 'boolean') throw absentComment()
          let conclusion = null
          if (req.resolved && req.conclusionId) {
            conclusion = store.require(row.number, req.conclusionId)
            if (conclusion.rootId !== current.id || !conclusion.parentId || conclusion.deleted
              || conclusion.botId && !allowed.has(conclusion.botId)) throw absentComment()
          }
          store.update(current, { resolvedAt: req.resolved ? Date.now() : null, conclusionId: conclusion?.id ?? null })
        } else throw new Error('未知的评论操作。')
      }
      this.db.prepare('INSERT INTO board_comment_requests VALUES(?,?,?,?)').run(requestId, row.number, id, digest)
    })
    this.changed(row.number)
    if (['post', 'edit', 'delete'].includes(op)) this.board.changed()
    this.schedule()
    return { commentId: id }
  }

  allowed(row) {
    return boardCommentTargets(this.rt, JSON.parse(row.summary))
  }

  annotations(row, allowed, inputs) {
    if (!Array.isArray(inputs) || inputs.length > 20) throw changedComment()
    const card = JSON.parse(row.meta)
    const annotations = inputs.map(({ commentId, start, end, note, quote }) => {
      const source = commentId && this.store.require(row.number, commentId)
      if (source && (source.deleted || source.botId && !allowed.has(source.botId))) throw absentComment()
      const body = source ? source.body : card.description ?? ''
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start ||
        end > body.length || end - start > 4000 || body.slice(start, end) !== quote) throw changedComment()
      const text = commentBody(note)
      if (!text || text.length > 2000) throw new Error('请填写 1–2000 字的批注。')
      return { commentId: source?.id ?? null, botId: source?.botId ?? null, quote, note: text }
    })
    if (JSON.stringify(annotations).length > 24_000) throw new Error('批注太长，请精简后发送。')
    return annotations
  }

  snapshot(id, commentId) {
    const row = this.checked({ id })
    const allowed = this.allowed(row)
    const meta = JSON.parse(row.meta)
    const card = JSON.parse(row.summary)
    const comment = this.store.require(row.number, commentId)
    if (comment.deleted || comment.botId && !allowed.has(comment.botId)) throw absentComment()
    const source = this.db.prepare(`SELECT id FROM board_comments WHERE number=? AND root_id=? AND seq<=?
      ORDER BY seq LIMIT 257`).all(row.number, comment.rootId, comment.seq)
    if (source.length > 256) throw new Error('讨论超过 256 条评论，请从更早的评论拆分。')
    const refs = new Set(card.refs)
    const attachments = []
    const comments = source.flatMap(item => {
      const entry = this.store.get(row.number, item.id)
      if (entry.deleted || entry.botId && !allowed.has(entry.botId)) return []
      if (entry.botId) refs.add('bot/' + entry.botId)
      const files = this.store.links(entry)
      attachments.push(...files.map(file => ({ ...file, commentId: entry.id })))
      return [{ text: entry.body, author: entry.botId ? allowed.get(entry.botId)?.name : 'User', at: entry.createdAt }]
    })
    const context = { title: card.title, description: meta.description ?? '', comments }
    if (Buffer.byteLength(JSON.stringify(context)) > 120_000 || attachments.length > 100 ||
      attachments.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024)
      throw new Error('来源讨论超过快照容量，请缩小拆分范围。')
    return { id, commentId, refs: [...refs], at: Date.now(), context, attachments, sourceRevision: card.version }
  }

  stopRun(id) {
    this.db.prepare(`UPDATE board_comment_runs SET state='stopped',reason=? WHERE id=?
      AND state IN ('queued','sending','sent','running','waiting')`).run('从工作看板停止。', id)
    const run = this.run.get(id)
    if (run) this.changed(run.number)
  }

  retryRun(row, run) {
    const original = this.availableRun(this.run.get(run.id))
    if (!original) throw absentComment()
    this.enqueue.run(workPrefix + randomUUID(), row.number, run.commentId, run.botId, Date.now(), 'queue', null, null, run.id)
    this.changed(row.number)
    this.schedule()
  }

  // Share task conversations between assignment deliveries and discussion replies.
  openConversation(number, bot, title, anchor) {
    const key = JSON.stringify([number, bot.id])
    const pending = this.opening.get(key)
    if (pending) return pending
    const resolve = async () => {
      this.writable()
      const route = this.db.prepare('SELECT session_id FROM board_comment_routes WHERE number=? AND bot_id=?')
        .get(number, bot.id)
      const sessionId = (anchor && await this.rt.openBotConversation(bot, anchor))
        || (route && await this.rt.openBotConversation(bot, route.session_id))
        || await this.rt.newBotConversation(bot, cardId(number) + ' · ' + title)
      this.writable()
      const current = this.rt.botOf(bot.id)
      if (!sessionId || !current || current.private) throw absentComment()
      this.db.prepare(`INSERT INTO board_comment_routes VALUES(?,?,?)
        ON CONFLICT(number,bot_id) DO UPDATE SET session_id=excluded.session_id`).run(number, bot.id, sessionId)
      return sessionId
    }
    const next = resolve().finally(() => this.opening.delete(key))
    this.opening.set(key, next)
    return next
  }

  reconcile(id, sessionId, turn) {
    const run = this.run.get(id)
    if (!run || !this.validSession(run, sessionId) || !runningStates.has(run.state)) return
    const reason = turn?.reason?.kind
    if (reason === 'aborted' && turn.reason.reason?.kind === 'disposed') return
    if (reason === 'completed' && !this.rt.waitsWork(id)) {
      this.recordTurn(id, sessionId, turn.turn, 'running')
      const bot = this.rt.botOf(run.bot_id)
      const answer = this.rt.answerText(id, turn.texts.join('\n\n').trim(), bot?.name ?? 'Bot')
      this.rt.closeWork(id, bot?.name, answer)
    } else if (reason === 'completed') {
      this.recordTurn(id, sessionId, turn.turn, 'waiting')
    } else if (reason === 'error' || reason === 'aborted') {
      this.recordTurn(id, sessionId, turn.turn, reason === 'error' ? 'failed' : 'stopped')
      this.rt.closeWork(id, this.rt.botOf(run.bot_id)?.name, '')
    }
  }

  owned(id) {
    return matchingWork(id) && !!this.run.get(id)
  }

  update(id, state, reason) {
    if (this.board.closed || this.rt.readOnly() || !matchingWork(id)) return
    const row = this.run.get(id)
    if (!row || row.state === state || !runningStates.has(row.state)) return
    this.db.prepare('UPDATE board_comment_runs SET state=?,reason=COALESCE(?,reason) WHERE id=?').run(state, reason ?? null, id)
    this.changed(row.number)
  }

  schedule() {
    if (this.scheduled || this.board.closed || this.rt.readOnly()) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.board.closed || this.rt.readOnly()) return
      for (const run of this.pending.all()) {
        const key = JSON.stringify([run.number, run.bot_id])
        if (this.sending.has(key)) continue
        this.sending.add(key)
        this.db.prepare("UPDATE board_comment_runs SET state='sending' WHERE id=?").run(run.id)
        this.changed(run.number)
        void this.send(this.run.get(run.id))
          .catch(error => {
            this.rt.warn?.('Godbot comment delivery %s: %s', run.id, error.message)
            if (!this.board.closed) this.update(run.id, this.run.get(run.id)?.session_id ? 'unknown' : 'failed', (this.rt.redactSecrets?.(error.message) ?? error.message).slice(0, 500))
          })
          .finally(() => {
            this.sending.delete(key)
            this.schedule()
          })
      }
    })
  }

  availableRun(run) {
    let row
    try { row = this.checked({ id: cardId(run.number) }) } catch { return null }
    const card = JSON.parse(row.summary)
    const allowed = boardCommentTargets(this.rt, card)
    const bot = allowed.get(run.bot_id)
    const entry = this.store.get(run.number, run.comment_id)
    if (!bot || !entry || entry.deleted) return null
    if (!entry.parentId && !entry.mentions.includes(bot.id) && assignee(card, allowed) !== bot.id) return null
    if (!['sending', 'sent', 'running', 'waiting', 'unknown', 'failed', 'stopped', 'terminal', 'unavailable', 'cancelled'].includes(run.state)) return null
    return { row, allowed, bot, entry }
  }

  // Called immediately before an initial send and by DSH's recovery delivery.
  admit(args) {
    if (!matchingWork(args.exchangeId)) return
    this.writable()
    const run = this.run.get(args.exchangeId)
    if (!run || !runningStates.has(run.state)) {
      this.rt.forgetDelivery?.(args.exchangeId)
      throw absentComment()
    }
    if (run.bot_id !== args.toId || !this.validSession(run, args.sessionId) || !this.availableRun(run)) {
      this.update(run.id, 'unavailable')
      this.rt.forgetDelivery?.(run.id)
      throw absentComment()
    }
    if (run.mode === 'steer' && run.state === 'sending') {
      const live = runningBoardWork(this.rt, args.sessionId, run.bound_id)
      if (!live || live.turn !== run.bound_turn || this.rt.nativeTerminals?.()[args.sessionId]) {
        this.update(run.id, 'failed', '所选运行已结束或已更换。')
        throw changedComment()
      }
    }
  }

  async send(run) {
    const prepared = this.availableRun(run)
    if (!prepared) return this.update(run.id, 'unavailable')
    const { row, allowed, bot, entry } = prepared
    const detail = await this.board.item({ id: cardId(run.number) })
    if (this.board.closed || this.rt.readOnly()) return
    const task = row.kind === 'task' && this.board.store.get('tasks', row.source_id)
    const anchor = (task?.boardSessionOwner === bot.id && task.boardSession)
      || (detail.origin?.botId === bot.id && detail.origin.sessionId)
    const sessionId = await this.openConversation(run.number, bot, detail.title, anchor)
    if (this.rt.nativeTerminals?.()[sessionId]) return this.update(run.id, 'terminal')
    const { files, images } = await this.agentFiles(entry)
    this.writable()
    if (this.run.get(run.id)?.state !== 'sending') return
    if (!this.availableRun(run)) return this.update(run.id, 'unavailable')
    if (run.mode === 'restart' || run.mode === 'steer') {
      const prior = this.board.runs.get(row, run.bound_id)
      if (prior.sessionId !== sessionId || prior.botId !== bot.id ||
        prior.turnId !== run.bound_turn || !runningBoardWork(this.rt, sessionId, prior.id)) {
        return this.update(run.id, 'failed', '所选运行已结束或已更换。')
      }
      if (run.mode === 'restart') await this.board.runs.stop(row, { runId: prior.id, turnId: prior.turnId }, prior)
    }
    if (this.run.get(run.id)?.state !== 'sending') return
    this.db.prepare('UPDATE board_comment_runs SET session_id=? WHERE id=?').run(sessionId, run.id)
    const parent = entry.parentId && this.store.get(run.number, entry.parentId)
    const root = entry.parentId && this.store.get(run.number, entry.rootId)
    const context = [...new Set([root?.id, parent?.id].filter(Boolean))]
      .map(id => this.store.get(run.number, id))
      .filter(comment => comment && !comment.deleted && (!comment.botId || allowed.has(comment.botId)))
      .map(comment => (allowed.get(comment.botId)?.name ?? 'User') + ': ' + comment.body.slice(0, 2000))
    const text = [
      cardId(run.number) + ' · ' + detail.title,
      detail.fields?.description ? 'Task description:\n' + detail.fields.description.slice(0, 4000) : '',
      detail.criteria ? 'Acceptance criteria:\n' + detail.criteria.slice(0, 4000) : '',
      context.length ? 'Earlier comments for context:\n' + context.join('\n\n') : '',
      'The user posted the following comment on the work item. Answer it here. Your reply will appear under this comment on the work board.',
      entry.body,
      entry.annotations?.length ? 'Quoted text and review notes:\n' + JSON.stringify(entry.annotations.map(({ quote, note }) => ({ quote, note }))) : '',
      files.length || images.length ? 'The user attached: ' + this.store.links(entry).map(file => file.name).join(', ') : '',
    ].filter(Boolean).join('\n\n')
    this.rt.openWork(run.id, { to: bot.id })
    await this.rt.deliver({
      role: 'request', work: run.id, fromName: 'Work board', toId: bot.id, sessionId,
      exchangeId: run.id, recordExchange: false, text, files, images, initiator: runOrigin('person'),
      steer: run.mode === 'steer', boardInline: run.mode === 'steer',
    })
    if (!this.board.closed && this.run.get(run.id)?.state === 'sending') this.update(run.id, 'sent')
  }

  async agentFiles(entry) {
    const rows = this.db.prepare('SELECT name,mime,bytes FROM board_comment_files WHERE comment_id=? AND id NOT IN (SELECT id FROM board_retired_artifacts) ORDER BY rowid').all(entry.id)
    const files = [], images = []
    if (!rows.length) return { files, images }
    const attachments = this.rt.ctx?.get?.('attachments')
    if (!attachments) throw new Error('Bot 附件服务不可用。')
    for (const file of rows) {
      const data = Buffer.from(file.bytes)
      const image = file.mime === 'image/png' && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        || file.mime === 'image/jpeg' && data.subarray(0, 3).toString('hex') === 'ffd8ff'
        || file.mime === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
      if (image && typeof attachments.saveImage === 'function') {
        images.push(await attachments.saveImage({ name: file.name, data, mediaType: file.mime }))
      } else {
        files.push(await attachments.saveFile({ name: file.name, data }))
      }
    }
    return { files, images }
  }

  observe(session, event) {
    if (this.board.closed || this.rt.readOnly() || !session?.id || !['user/message', 'turn/end'].includes(event.type)) return
    const live = this.rt.live?.get(session.id)
    if (event.type === 'user/message') {
      const source = event.data?.source
      const id = this.rt.workOf?.(source) ?? source?.exchangeId
      if (!matchingWork(id)) return
      this.recordTurn(id, session.id, live?.turn ?? event.data?.turn, 'running')
    } else if (event.type === 'turn/end') {
      if (!live || live.switched || live.suppressedSubagent) return
      const reason = event.data?.reason
      const idOf = source => this.rt.workOf?.(source) ?? source?.exchangeId
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') return
      if (live.cut && reason?.kind === 'aborted' && ['godbot/steer','ds-bot/steer'].includes(reason.reason?.reason)) return
      const state = reason?.kind === 'error' ? 'failed' : reason?.kind === 'aborted' ? 'stopped' : 'running'
      const error = reason?.kind === 'error' ? reason.error?.message ?? reason.error?.code ?? 'Bot 回合失败'
        : reason?.kind === 'aborted' ? 'Bot 回合已停止' : null
      const detail = error && (this.rt.redactSecrets?.(String(error)) ?? String(error)).slice(0, 500)
      this.recordTurn(idOf(live.info), session.id, live.turn ?? event.data?.turn, state, detail)
      if (state !== 'running') {
        for (const joined of live.joined ?? []) this.recordTurn(idOf(joined.info), session.id, live.turn, state, detail)
      }
    }
  }

  recordTurn(id, sessionId, turnId, state, reason) {
    if (!matchingWork(id)) return
    const run = this.run.get(id)
    if (!run || !runningStates.has(run.state) || !this.validSession(run, sessionId)) return
    const turn = Number.isSafeInteger(turnId) ? turnId : run.turn_id
    if (run.state === state && run.session_id === sessionId && run.turn_id === turn) return
    this.db.prepare('UPDATE board_comment_runs SET session_id=?,turn_id=?,state=?,reason=COALESCE(?,reason) WHERE id=?')
      .run(sessionId, turn, state, reason ?? null, id)
    this.changed(run.number)
  }

  validSession(run, sessionId) {
    if (run.session_id === sessionId) return true
    const bot = this.rt.botOf(run.bot_id)
    if (!bot || !run.session_id || !sessionId) return false
    const head = conversationHead(bot, run.session_id)
    return !!head && head === conversationHead(bot, sessionId)
  }

  reply(id, text) {
    if (this.board.closed || this.rt.readOnly() || !matchingWork(id)) return
    const run = this.run.get(id)
    if (!run || !runningStates.has(run.state)) return
    let row
    try { row = this.checked({ id: cardId(run.number) }) } catch { return this.update(id, 'unavailable') }
    const allowed = boardCommentTargets(this.rt, JSON.parse(row.summary))
    const parent = this.store.get(run.number, run.comment_id)
    if (!parent || !allowed.has(run.bot_id)) return this.update(id, 'unavailable')
    const answer = String(text ?? '').trim()
    if (!answer) return this.update(id, 'unknown')
    const body = answer.length > commentLength ? answer.slice(0, commentLength - 1) + '…' : answer
    const reply = this.board.store.transaction(() => {
      const commentId = this.store.insert(run.number, parent, { body, botId: run.bot_id })
      this.db.prepare("UPDATE board_comment_runs SET reply_id=?,state='answered' WHERE id=?").run(commentId, id)
      return commentId
    })
    this.changed(run.number)
    this.rt.addNotice?.({
      kind: 'message',
      botId: run.bot_id,
      name: allowed.get(run.bot_id).name,
      sessionId: run.session_id ?? undefined,
      workItemId: cardId(run.number),
      commentId: reply,
      text: cardId(run.number) + ' · ' + body.replace(/\s+/g, ' ').slice(0, 160),
    })
  }
}
