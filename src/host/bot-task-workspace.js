import { delegatedOrigin, runOrigin } from './run-origin.js'
import { createHash } from 'node:crypto'
import { TeamActions, teamMember } from './team.js'
import { listWorkflows, saveWorkflow, startWorkflow } from './workflows.js'
import { taskBudgetReceipt } from './bot-budget.js'

export const botWorkspaceId = 'godbot-workspace'
const ownedStates = new Set(['sending', 'sent'])
const activeTasks = new Set(['assigned', 'working', 'awaiting-report'])
const unavailable = 'Bot 已移除、设为私有，或工作区已变为只读。'
const writable = rt => { if (rt.readOnly()) throw new Error('当前 Bot 工作区为只读。') }

function digest(request) {
  const canonical = JSON.stringify(request, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  return createHash('sha256').update(canonical).digest('hex')
}

function pendingFor(rt, delivery) {
  if (!delivery?.sessionId) return []
  const { sessionId } = delivery
  const info = rt.live?.get(sessionId)?.info
  const ownsTurn = info && (rt.workOf(info) ?? info.exchangeId) === delivery.id
  const question = rt.state.questions?.[sessionId]
  const pending = ownsTurn ? (rt.approvalsView?.() ?? []).filter(item => item.sessionId === sessionId)
    .map(item => ({ id: item.id, type: 'permission', status: 'pending', turnId: delivery.turnId })) : []
  if (question?.id && (ownsTurn || question.id === delivery.questionId))
    pending.push({ id: question.id, type: 'question', status: 'pending', turnId: delivery.turnId })
  return pending
}

// Older task and workflow code expects a team/member lookup. Project that lookup
// from the live roster on every read. Bot configuration and identity have one owner.
function botMember(rt, bot) {
  if (!bot || bot.private) return
  return { id: bot.id, teamId: botWorkspaceId, name: bot.name, role: bot.role ?? '',
    model: bot.model ?? bot.appliedModel, sessionId: rt.chatOf(bot.id), cwd: bot.workDir,
    accountProfileId: bot.accountProfileId ?? null }
}
function members(rt) { return Object.values(rt.state.bots).map(bot => botMember(rt, bot)).filter(Boolean) }
function team(rt, bots = members(rt)) {
  const lead = (rt.state.mainBotIds ?? []).find(id => bots.some(bot => bot.id === id)) ?? bots[0]?.id ?? null
  return { id: botWorkspaceId, name: 'Bot 团队', leadId: lead, stopped: false }
}

function visibleRooms(rt, bots) {
  const allowed = new Set(bots.map(bot => bot.id))
  return Object.values(rt.state.rooms ?? {}).filter(room => !room.private && room.members.every(id => allowed.has(id)))
}

export function botWorkspaceSnapshot(rt, tasks, messages) {
  const bots = members(rt), workspace = team(rt, bots)
  return { workspace, teamId: workspace.id, mainBotId: workspace.leadId, readOnly: !!rt.readOnly(), bots,
    rooms: visibleRooms(rt, bots).map(({ id, name, members }) => ({ id, name, members })),
    tasks: tasks.filter(row => row.teamId === workspace.id), messages: messages.filter(row => row.teamId === workspace.id) }
}

function rosterStore(raw, rt) {
  const onlyRuntime = collection => {
    if (collection === 'teams' || collection === 'members') throw new Error('请在 Bot 团队中管理成员。')
  }
  return Object.assign(Object.create(raw), {
    get(collection, id) {
      if (collection === 'teams') return id === botWorkspaceId ? team(rt) : undefined
      if (collection === 'members') return typeof id === 'string' ? botMember(rt, rt.botOf(id)) : undefined
      return raw.get(collection, id)
    },
    all(collection) {
      if (collection === 'teams') return [team(rt)]
      if (collection === 'members') return members(rt)
      return raw.all(collection)
    },
    forRun(collection, id) {
      if (collection === 'interactions') return raw.forRun('tasks', id)
        .flatMap(task => pendingFor(rt, raw.get('botTaskDeliveries', task.assignmentId)))
      return raw.forRun(collection, id)
    },
    outstandingBotWork(tasks) {
      return tasks.map(task => raw.get('botTaskDeliveries', task.assignmentId))
        .filter(row => row && (row.state === 'queued' || ownedStates.has(row.state)))
        .map(row => {
          const budget = taskBudgetReceipt(raw, row.sessionId, row.id)
          return { id: row.id, budgetHold: budget?.status === 'held' ? budget : undefined }
        })
    },
    put(collection, row) { onlyRuntime(collection); return raw.put(collection, row) },
    update(collection, id, patch) { onlyRuntime(collection); return raw.update(collection, id, patch) },
    remove(collection, id) { onlyRuntime(collection); return raw.remove(collection, id) },
  })
}

export class BotTaskWorkspace {
  constructor(rawStore, rt) {
    this.rt = rt
    this.store = rosterStore(rawStore, rt)
    this.team = new TeamActions(this.store, request => this.queue(request))
    this.scheduled = new Set()
    this.active = new Map()
    this.queues = new Map()
    this.uncertain = new Set()
    this.stopWatching = rt.onSaved?.(() => {
      // A Bot can become private or disappear after dispatch, including while
      // it waits on an approval. Drop its pending receipt before exposing it.
      if (rt.readOnly()) return
      for (const [botId, id] of this.active) {
        if (!this.store.get('members', botId)) this.botFailed(id, 'unknown', unavailable)
      }
    })
    // queued never crossed the delivery boundary. A send interrupted by a Host
    // restart can already be in DSH's inbox. Never automatically send it twice.
    for (const row of this.store.all('botTaskDeliveries')) {
      if (ownedStates.has(row.state)) {
        // A budget hold contains the exact undelivered Bot message. Its own
        // durable release receipt is responsible for resuming it after restart.
        const held = taskBudgetReceipt(this.store, row.sessionId, row.id)
        if (held?.status === 'held' && this.store.get('members', row.botId) && !rt.readOnly()) this.active.set(row.botId, row.id)
        else this.botFailed(row.id, 'unknown', '宿主重启，尚未确认上次派工结果。')
      } else if (row.state === 'queued') this.remember(row)
    }
  }

  targets(teamId) {
    if (teamId !== botWorkspaceId) return []
    const bots = this.store.all('members')
    return bots.map(bot => ({ id: 'bot/' + bot.id, name: bot.name })).concat(
      visibleRooms(this.rt, bots).map(room => ({ id: 'room/' + room.id, name: room.name })))
  }

  snapshot() { return botWorkspaceSnapshot(this.rt, this.store.all('tasks'), this.store.all('messages')) }

  workflows() { return listWorkflows(this.store, botWorkspaceId) }

  mutate(request, apply = scoped => this.apply(scoped)) {
    writable(this.rt)
    if (request.teamId !== undefined && request.teamId !== botWorkspaceId) throw new Error('请选择当前 Bot 团队。')
    const req = { ...request, teamId: botWorkspaceId }
    const operation = req.requestId && 'bot-tasks/' + req.requestId
    const fingerprint = operation && digest(req)
    return this.store.transaction(() => {
      const previous = operation && this.store.get('receipts', operation)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('相同请求 ID 已用于其他操作。')
        return previous.result
      }
      const result = apply(req)
      if (operation) this.store.put('receipts', { id: operation, fingerprint, result })
      return result
    })
  }

  apply(req) {
    const { store, team } = this
    switch (req.action) {
      case 'workflow.save': return saveWorkflow(store, req)
      case 'workflow.run': return startWorkflow(this, req)
      case 'task.create': {
        store.require('members', req.ownerId)
        return team.assign(req)
      }
      case 'task.report': return team.report(req)
      case 'task.fail': return team.fail(req)
      case 'task.review': {
        const task = team.task(req)
        const delivery = store.get('botTaskDeliveries', task.assignmentId)
        if (pendingFor(this.rt, delivery).length)
          throw new Error('请先处理 Bot 会话里待回答的问题或审批。')
        return team.review(req)
      }
      case 'task.transfer': {
        const task = team.task(req, true)
        const delivery = store.get('botTaskDeliveries', task.assignmentId)
        if (delivery && ownedStates.has(delivery.state)) throw new Error('请先在该 Bot 的对话中停止当前派工，再转交任务。')
        if (!store.get('members', task.ownerId) && task.status === 'failed') {
          return team.redispatch(task, teamMember(store, botWorkspaceId, req.ownerId).id)
        }
        return team.transfer(req)
      }
      case 'task.retry': {
        const task = team.task(req, true)
        teamMember(store, botWorkspaceId, task.ownerId)
        return team.retry(req)
      }
      default: throw new Error('未知的 Bot 任务操作。')
    }
  }

  queue({ messageId, memberId, taskId }) {
    const message = this.store.require('messages', messageId)
    const id = message.kind === 'assignment' ? message.id : message.id + '/' + memberId
    this.remember(this.store.put('botTaskDeliveries', { id, messageId, botId: memberId, taskId, state: 'queued' }))
  }

  remember(row) {
    const queued = this.queues.get(row.botId) ?? []
    queued.push(row.id)
    this.queues.set(row.botId, queued)
    this.schedule(row.botId)
  }

  schedule(botId) {
    if (this.closing || this.scheduled.has(botId)) return
    this.scheduled.add(botId)
    queueMicrotask(() => {
      this.scheduled.delete(botId)
      if (!this.closing) this.dispatchNext(botId)
    })
  }

  dispatchNext(botId) {
    if (this.active.has(botId) || this.rt.readOnly()) return
    const queue = this.queues.get(botId)
    if (!queue?.length) return
    const next = this.store.get('botTaskDeliveries', queue.shift())
    if (!queue.length) this.queues.delete(botId)
    // A surrounding workflow transaction may have rolled back a queued item.
    if (next?.state !== 'queued') return this.schedule(botId)
    const { store, rt } = this
    const task = next.taskId && store.get('tasks', next.taskId)
    const original = store.get('messages', next.messageId)
    if (!original) return this.botFailed(next.id, 'unknown', '找不到原派工记录。')
    if (original.kind === 'assignment' && (task?.assignmentId !== next.id || !activeTasks.has(task.status))) {
      store.update('botTaskDeliveries', next.id, { state: 'superseded' })
      return this.schedule(botId)
    }
    const bot = store.get('members', botId)
    if (!bot || rt.readOnly()) return this.botFailed(next.id, 'failed', unavailable)
    store.update('botTaskDeliveries', next.id, { state: 'sending', sessionId: bot.sessionId })
    this.active.set(botId, next.id)
    const dispatch = async () => {
      rt.openWork(next.id, { to: bot.id })
      const run = task?.runId && store.get('automationRuns', task.runId)
      const initiator = run?.initiator ?? (task?.runId ? runOrigin('unknown', task.runId)
        : original.from && original.from !== 'user' ? delegatedOrigin(undefined, original.from) : runOrigin('person'))
      await rt.deliver({ role: 'request', fromName: '任务编排', toId: bot.id, sessionId: bot.sessionId, exchangeId: next.id, text: original.text, initiator })
      if (!this.closing && store.get('botTaskDeliveries', next.id)?.state === 'sending')
        store.update('botTaskDeliveries', next.id, { state: 'sent' })
    }
    void dispatch().catch(error => {
      if (!this.closing) this.botFailed(next.id, 'unknown', String(error?.message ?? error))
    })
  }

  resume() {
    if (this.closing || this.rt.readOnly()) return
    for (const id of this.uncertain) this.botFailed(id, 'unknown', '工作区只读期间收到派工回执，需要核对。')
    this.uncertain.clear()
    for (const botId of this.queues.keys()) if (!this.active.has(botId)) this.schedule(botId)
  }

  ownsWork(id) { return !!this.store.get('botTaskDeliveries', id) }

  botReply(id, text) {
    const delivery = this.store.get('botTaskDeliveries', id)
    if (!delivery || !ownedStates.has(delivery.state)) return
    const { store, team } = this
    if (!store.get('members', delivery.botId) || this.rt.readOnly()) return this.botFailed(id, 'unknown', unavailable)
    if (taskBudgetReceipt(store, delivery.sessionId, id)?.status === 'held') return
    if (typeof text !== 'string' || !text.trim()) return this.botFailed(id, 'unknown', 'Bot 没有返回可归属到该任务的结果。')
    store.transaction(() => {
      const original = store.require('messages', delivery.messageId)
      const task = store.get('tasks', delivery.taskId)
      if (original.kind === 'assignment' && task?.assignmentId === id && activeTasks.has(task.status)) {
        team.recordReport(task, original, text.trim(), delivery.botId)
      } else if (original.kind === 'message') {
        team.deliver({ teamId: botWorkspaceId, from: delivery.botId, to: [original.from], kind: 'ack',
          replyTo: original.id, text, exchangeId: original.exchangeId }, { enqueue: false })
      }
      store.update('botTaskDeliveries', id, { state: 'reported' })
    })
    this.active.delete(delivery.botId)
    this.schedule(delivery.botId)
  }

  botFailed(id, kind, reason) {
    const delivery = this.store.get('botTaskDeliveries', id)
    if (!delivery || !(ownedStates.has(delivery.state) || delivery.state === 'queued')) return
    if (this.rt.readOnly()) { this.uncertain.add(id); return }
    this.store.transaction(() => {
      const budget = taskBudgetReceipt(this.store, delivery.sessionId, id)
      if (budget?.status === 'held') this.store.update('usageDeferred', budget.id, {status:'cancelled', message:null})
      this.store.update('botTaskDeliveries', id, { state: kind, reason })
      const task = this.store.get('tasks', delivery.taskId)
      if (task?.assignmentId === id && activeTasks.has(task.status)) this.team.markFailed(task, kind, reason)
    })
    if (this.active.get(delivery.botId) === id) this.active.delete(delivery.botId)
    this.schedule(delivery.botId)
  }

  observeEnd(sessionId, entry, reason) {
    if (!entry || this.rt.readOnly()) return
    const workOf = info => info && (this.rt.workOf(info) ?? info.exchangeId)
    const ids = new Set([entry?.info, ...(entry?.joined ?? []).map(join => join.info)].map(workOf))
    for (const id of ids) {
      const delivery = this.store.get('botTaskDeliveries', id)
      if (!delivery || !ownedStates.has(delivery.state)) continue
      if (taskBudgetReceipt(this.store, sessionId, id)?.status === 'held') continue
      // The runtime carries an interrupted steer/part switch into its successor turn.
      if (entry.switched || entry.suppressedSubagent ||
          entry.cut && reason?.kind === 'aborted' && ['godbot/steer', 'ds-bot/steer'].includes(reason.reason?.reason)) continue
      if (ids.size > 1) this.botFailed(id, 'unknown', '同一 Bot 回合包含多个请求，无法单独确认此任务的结果。')
      else if (reason?.kind === 'error' || reason?.kind === 'aborted')
        this.botFailed(id, reason.kind === 'error' ? 'failed' : 'interrupted', 'Bot 回合' + (reason.kind === 'error' ? '失败' : '已停止'))
      else this.store.update('botTaskDeliveries', id, { sessionId, turnId: entry.turn,
        questionId: this.rt.state.questions?.[sessionId]?.id ?? null })
    }
  }

  dispose() { this.closing = true; this.stopWatching?.() }
}
