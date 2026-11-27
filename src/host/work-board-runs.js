import { mobileToolDetail, mobileTurnProcess } from './team-runtime/mobile-tool-timeline.js'
import { cardId } from './work-board-index.js'

const failure = new Set(['failed', 'stopped', 'unknown', 'interrupted', 'terminal', 'unavailable', 'cancelled'])
const unsettled = new Set(['queued', 'sending', 'sent', 'running', 'waiting'])
const denied = () => Object.assign(new Error('找不到这次运行，或该运行已变化。'), { code: 'bot/stale' })

const workOf = (rt, source) => source && (rt.workOf?.(source) ?? source.exchangeId)

export function runningBoardWork(rt, sessionId, workId) {
  const entry = rt.live?.get(sessionId)
  return entry?.turn !== undefined && workOf(rt, entry.info) === workId ? entry : undefined
}

// Only remove the addressed message or stop the exact turn that owns it. A
// session can also contain unrelated chat and background work.
export async function stopBoardWork(rt, sessionId, workId, expectedTurn, authorize) {
  if (!sessionId || rt.nativeTerminals?.()[sessionId]) throw denied()
  const agent = await rt.resolveAgent(sessionId)
  authorize()
  if (rt.readOnly() || rt.nativeTerminals?.()[sessionId]) throw denied()
  const entry = runningBoardWork(rt, sessionId, workId)
  if (entry) {
    if (expectedTurn != null && expectedTurn !== entry.turn) throw denied()
    if (entry.joined?.some(item => item.info?.boardInline !== true)) {
      throw new Error('该回合同时包含其他请求，请在会话中检查后停止。')
    }
    if (typeof agent.cancel !== 'function') throw denied()
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return
  }
  if (expectedTurn != null) throw denied()
  const messages = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
  const message = messages.find(item => workOf(rt, item.source) === workId)
  if (!message || !agent.inbox.remove(message.id)) throw denied()
  await rt.ctx?.sessions?.flush?.(agent.session)
}

export class WorkBoardRuns {
  constructor(board, checked) {
    this.board = board
    this.checked = checked
    this.rt = board.rt
    this.store = board.store
    const db = board.db
    this.messages = db.prepare(`SELECT data FROM records WHERE collection='messages'
      AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.kind')='assignment' ORDER BY seq DESC`)
    this.comments = db.prepare(`SELECT r.* FROM board_comment_runs r JOIN board_comments c ON c.id=r.comment_id
      WHERE r.number=? AND COALESCE(json_extract(c.data,'$.deleted'),0)=0 ORDER BY r.created DESC,r.rowid DESC`)
  }

  assignment(delivery, task) {
    if (!delivery) return null
    const live = runningBoardWork(this.rt, delivery.sessionId, delivery.id)
    const stoppedOrFailed = failure.has(delivery.state)
    const current = task?.assignmentId === delivery.id
    return {
      id: delivery.id, kind: 'assignment', botId: delivery.botId,
      sessionId: delivery.sessionId, turnId: Number.isSafeInteger(live?.turn) ? live.turn : delivery.turnId,
      since: live?.since,
      status: stoppedOrFailed ? delivery.state : live ? 'running' : delivery.state,
      reason: delivery.reason,
      canStop: current && unsettled.has(delivery.state) && (!live?.joined?.some(item => item.info?.boardInline !== true)),
      canRetry: current && task.status === 'failed' && stoppedOrFailed,
    }
  }

  comment(run) {
    const live = runningBoardWork(this.rt, run.session_id, run.id)
    return {
      id: run.id, kind: 'comment', commentId: run.comment_id, botId: run.bot_id, sessionId: run.session_id,
      turnId: Number.isSafeInteger(live?.turn) ? live.turn : run.turn_id,
      since: live?.since, status: run.state, reason: run.reason, mode: run.mode, retryOf: run.retry_of,
      canStop: unsettled.has(run.state) && (run.state === 'queued' || !run.session_id || Boolean(live) || run.state === 'sent'),
      canRetry: failure.has(run.state) && run.state !== 'unknown',
    }
  }

  read(row) {
    const { board, rt, store } = this
    const allowed = board.discussion.allowed(row)
    const result = this.comments.all(row.number).filter(run => allowed.has(run.bot_id))
      .map(run => ({ ...this.comment(run), createdAt: run.created }))
    if (row.kind === 'task') {
      const task = store.get('tasks', row.source_id)
      for (const record of this.messages.all(row.source_id)) {
        const message = JSON.parse(record.data)
        const run = this.assignment(store.get('botTaskDeliveries', message.id), task)
        if (run && allowed.has(run.botId)) result.push({ ...run, attempt: message.attempt, createdAt: Date.parse(message.createdAt) })
      }
    }
    if (row.kind === 'room') {
      const task = rt.state.rooms?.[row.scope]?.tasks?.[row.source_id]
      if (task && allowed.has(task.botId)) {
        for (const receipt of task.boardRuns ?? []) {
          const work = receipt.workId && runningBoardWork(rt, receipt.sessionId, receipt.workId)
          const running = work?.turn === receipt.turnId
          result.push({
            id: 'group/' + receipt.sessionId + '/' + receipt.turnId, kind: 'group', roomId: row.scope, botId: task.botId,
            sessionId: receipt.sessionId, turnId: receipt.turnId, workId: receipt.workId, createdAt: receipt.at,
            status: running ? 'running' : 'recorded', canStop: Boolean(running && !work.joined?.length),
          })
        }
      }
    }
    if (row.kind === 'run') {
      const run = store.get('automationRuns', row.source_id)
      const tasks = store.forRun('fullTeamTasks', row.source_id)
      const current = new Map(tasks.map(task => [task.id, task]))
      const receipts = store.forRun('fullTeamEvidence', row.source_id).filter(item => ['report', 'run-failure'].includes(item.kind))
      for (const item of receipts) {
        const task = current.get(item.taskId)
        const botId = rt.executionHistory?.ownerOf(item.receipt?.sessionId) ?? task?.targetId?.split('/')[1]
        if (!allowed.has(botId)) continue
        result.push({
          id: item.id, kind: 'team', botId, sessionId: item.receipt?.sessionId, turnId: item.receipt?.turnId,
          status: item.status ?? (task?.attempt === item.attempt ? task.status : 'reported'),
          reason: item.kind === 'run-failure' ? item.evidence : undefined,
          attempt: item.attempt, createdAt: Date.parse(item.createdAt),
        })
      }
      for (const task of tasks.filter(task => ['running', 'failed', 'stopped', 'unknown'].includes(task.status))) {
        const entry = [...(rt.live ?? [])].find(([sid]) => runningBoardWork(rt, sid, task.workId))
        const failureReceipt = task.boardFailureReceipt
        const botId = task.targetId.startsWith('bot/') ? task.targetId.slice(4) : failureReceipt?.botId ?? (entry && rt.selfOf?.(entry[0]))
        if (!allowed.has(botId)) continue
        result.push({
          id: task.workId, kind: 'team', botId, sessionId: entry?.[0] ?? failureReceipt?.sessionId,
          turnId: entry?.[1].turn ?? failureReceipt?.turnId,
          status: task.status, reason: task.detail, canStop: Boolean(entry), attempt: task.attempt,
          canRetry: task.id === run?.rootTaskId && ['failed', 'stopped'].includes(task.status) &&
            !tasks.some(other => other.status === 'running'),
          createdAt: Date.parse(task.createdAt),
        })
      }
    }
    const superseded = new Set(result.map(run => run.retryOf).filter(Boolean))
    return result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.id.localeCompare(a.id))
      .map(run => ({
        ...run, name: allowed.get(run.botId)?.name, canStop: !rt.readOnly() && !!run.canStop,
        canRetry: !rt.readOnly() && !!run.canRetry && !superseded.has(run.id),
      }))
  }

  active(row) {
    const rt = this.rt
    const active = {}
    for (const run of this.read(row)) {
      if (run.kind === 'group' || !runningBoardWork(rt, run.sessionId, run.id) || active[run.botId]) continue
      if (rt.nativeTerminals?.()[run.sessionId]) continue
      const native = rt.state.localAgents?.sessions?.[run.sessionId]
      active[run.botId] = { runId: run.id, turnId: run.turnId, steer: !native || rt.nativeInboxBusy?.(run.sessionId) === true }
    }
    return active
  }

  get(row, id) {
    const run = this.read(row).find(run => run.id === id)
    if (!run) throw denied()
    return run
  }

  async query(req) {
    await this.board.warm()
    const row = this.checked(req)
    if (!req.runId) {
      const runs = this.read(row)
      const index = req.after ? runs.findIndex(run => run.id === req.after) + 1 : 0
      if (req.after && index === 0) throw denied()
      const page = runs.slice(index, index + 30)
      return { runs: page, next: index + 30 < runs.length ? page.at(-1).id : null }
    }
    const run = this.get(row, req.runId)
    if (!Number.isSafeInteger(run.turnId) || !run.sessionId || !this.rt.executionHistory)
      return { run, events: [], unavailable: true }
    const ref = { botId: run.botId, sessionId: run.sessionId, turn: run.turnId, knownRev: req.knownRev, before: req.before }
    const data = req.toolId
      ? await mobileToolDetail(this.rt, { ...ref, toolId: req.toolId }, { associatedWork: true })
      : await mobileTurnProcess(this.rt, ref, { associatedWork: true })
    const current = this.get(this.checked(req), req.runId)
    if (current.sessionId !== run.sessionId || current.turnId !== run.turnId) throw denied()
    return { run: current, ...data }
  }

  async stop(row, req, run = this.get(row, req.runId)) {
    if (!run.canStop || (run.turnId != null && run.turnId !== req.turnId)) throw denied()
    const assertCurrent = () => {
      const latest = this.get(this.checked({ id: cardId(row.number) }), run.id)
      if (latest.sessionId !== run.sessionId || !latest.canStop || latest.turnId !== run.turnId) throw denied()
    }
    if (run.sessionId) await stopBoardWork(this.rt, run.sessionId, run.workId ?? run.id, run.turnId, assertCurrent)
    else assertCurrent()
    if (run.kind === 'assignment') this.board.service.botTasks.botFailed(run.id, 'stopped', '从工作看板停止。')
    if (run.kind === 'comment') this.board.discussion.stopRun(run.id)
    if (run.kind === 'team') this.board.service.automation.full.end(run.id, 'stopped', '从工作看板停止。', { sessionId: run.sessionId, turnId: run.turnId, botId: run.botId })
    this.board.changed()
  }

  retry(row, req) {
    const run = this.get(row, req.runId)
    if (!run.canRetry) throw denied()
    if (run.kind === 'comment') {
      this.board.discussion.retryRun(row, run)
      return
    }
    if (run.kind === 'team') {
      this.board.service.automation.full.retryBoardRoot(row.source_id, run.id)
      return
    }
    const task = this.store.require('tasks', row.source_id)
    this.board.service.botTasks.apply({
      action: 'task.retry', teamId: task.teamId, taskId: task.id, expectedRevision: task.revision,
    })
  }
}
