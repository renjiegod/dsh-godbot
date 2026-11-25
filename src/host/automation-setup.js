import { createHash } from 'node:crypto'
import { normalizeRoutineTiming } from './routine-timing.js'
import { checkOnlyScheduleMarker } from './run-origin.js'
import { createTeamSchedule, teamScheduleAction } from './team-schedules.js'
import { required } from './team.js'

const collection = 'automationSetupRequests'
const reportPrompt = 'Check and report what you find. Leave external systems and files unchanged.'

function scheduleOf(input, message) {
  if (message) {
    const when = input?.kind === 'once' ? { kind: 'at', at: input.at }
      : input?.kind === 'interval' ? { kind: 'every', minutes: input.minutes } : input
    if (!['at', 'every', 'daily', 'weekly', 'cron', 'rrule'].includes(when?.kind)) throw new Error('请选择执行时间')
    return when
  }
  return normalizeRoutineTiming(input)
}

function messageItem(task, runtime) {
  const { kind, scheduledAt, everySeconds, weekdays, time, timeZone, expression, rrule } = task
  let when
  switch (kind) {
    case 'after':
    case 'at': when = { kind: 'once', at: scheduledAt }; break
    case 'every': when = { kind: 'interval', minutes: everySeconds / 60, seconds: everySeconds }; break
    case 'daily':
    case 'weekly': when = { kind, time, timeZone, weekdays }; break
    case 'cron': when = { kind, timeZone, expression }; break
    case 'rrule': when = { kind, rrule }; break
  }
  const marked = task.prompt?.startsWith(checkOnlyScheduleMarker)
  return {
    source: 'message', id: task.id, title: task.title,
    target: { kind: 'message', id: task.roomId ?? task.botId },
    trigger: { kind: 'schedule', when }, status: task.state,
    instructions: marked ? task.prompt.slice(checkOnlyScheduleMarker.length) : task.prompt,
    checkOnly: Boolean(marked || runtime.state.scheduleCheckIns?.[task.id]),
    nextAt: task.status === 'active' ? scheduledAt : null,
    sessionId: task.sessionId, updatedAt: task.updatedAt ?? null,
    executionActive: task.executionActive, deliveryFloorEndsAt: task.deliveryFloorEndsAt,
  }
}

function workTarget(row) {
  return row.workflowId ? { kind: 'workflow', id: row.workflowId, name: row.workflowName, revision: row.workflowRevision }
    : { kind: 'task', id: row.ownerId }
}

function routineItem(row) {
  return {
    source: 'routine', id: row.id, title: row.title, target: workTarget(row),
    trigger: { kind: 'schedule', when: row.schedule }, status: row.status,
    instructions: row.criteria, checkOnly: row.checkOnly === true,
    revision: row.revision, nextAt: row.nextAt, issue: row.lastError,
  }
}

function eventItem(source, row, listener) {
  return {
    source, id: row.id, title: row.label, target: workTarget(row),
    trigger: source === 'webhook' ? { kind: source, url: listener ? listener + '/hooks/' + row.id : undefined }
      : { kind: source, repo: row.repo, eventType: row.eventType },
    status: row.paused ? 'paused' : 'active', checkOnly: row.checkOnly === true,
    issue: row.issue, lastChecked: row.lastChecked, lastRunId: row.lastRunId,
  }
}

export function planAutomation(req) {
  const target = req.target
  const trigger = req.trigger
  if (!['message', 'task', 'workflow'].includes(target?.kind) || !['schedule', 'webhook', 'github'].includes(trigger?.kind)) {
    throw new Error('请选择自动化执行对象和触发方式')
  }
  const checkOnly = req.checkOnly === true
  const workflow = target.kind === 'workflow'
  const message = target.kind === 'message'
  const title = required(req.title, '任务名称')
  if (message && title.length > 120) throw new Error('任务名称最多 120 字')
  const targetId = required(target.id, workflow ? '工作流' : message ? '会话' : 'Bot')
  const description = workflow ? '' : required(req.instructions, message ? '指令' : '验收条件')
  const instructions = checkOnly ? [reportPrompt, description].filter(Boolean).join('\n\n') : description
  if (workflow && (!Number.isInteger(target.revision) || target.revision < 1)) throw new Error('请选择工作流版本')
  const fields = workflow ? { workflowId: targetId, workflowRevision: target.revision }
    : { ownerId: targetId, criteria: instructions }
  if (trigger.kind === 'schedule') {
    const when = scheduleOf(trigger.when, message)
    if (message) return { action: 'team-workspace.scheduleCreate', title, prompt: instructions, target: targetId, when, checkOnly }
    return { action: 'automation.routine.create', title, schedule: when, target: workflow ? 'workflow' : 'member', checkOnly, ...fields }
  }
  if (message) throw new Error('事件触发器可派工或运行已保存的工作流')
  if (trigger.kind === 'webhook') return { action: 'automation.hook', title, label: title, checkOnly, ...fields }
  return { action: 'automation.githubCreate', title, label: title, repo: trigger.repo, eventType: trigger.eventType,
    includeLatest: trigger.includeLatest === true, checkOnly, ...fields }
}

export class AutomationSetup {
  constructor(service) {
    this.service = service
    this.creating = new Map()
  }

  async handle(req) {
    switch (req.action) {
      case 'automation.setup.view': return this.view(req.teamId)
      case 'automation.setup.history': return this.history(req)
      case 'automation.setup.change': return this.change(req)
      case 'automation.setup.create': return this.createOnce(req)
      default: throw new Error('未知自动化设置操作')
    }
  }

  async view(teamId) {
    const { service } = this
    const runtime = service.runtime
    await runtime.load()
    const [schedules, { hooks, sources, url }] = await Promise.all([
      runtime.scheduleEndpoint('schedules', {}),
      service.automation.owner({ action: 'automation.list', teamId }),
    ])
    const { routines, workflows } = service.routines.owner({ action: 'automation.routine.list', teamId })
    return {
      version: 1, available: schedules.available, workflows,
      items: [
        ...schedules.tasks.map(task => messageItem(task, runtime)),
        ...routines.map(routineItem),
        ...hooks.map(row => eventItem('webhook', row, url)),
        ...sources.map(row => eventItem('github', row)),
      ],
    }
  }

  async history(req) {
    const { service } = this
    if (req.source === 'routine')
      return service.routines.owner({ action: 'automation.routine.history', teamId: req.teamId, id: req.id })
    if (req.source !== 'message') throw new Error('无法读取此自动化的运行记录。')
    const value = await teamScheduleAction(service.runtime, {
      action: 'team-workspace.scheduleHistory', id: req.id, sessionId: req.sessionId, before: req.before,
    })
    return {
      items: value.records.map(row => ({ id: row.messageId, at: row.deliveredAt, state: 'delivered',
        sessionId: row.targetSessionId, prompt: row.prompt?.startsWith(checkOnlyScheduleMarker)
          ? row.prompt.slice(checkOnlyScheduleMarker.length) : row.prompt })),
      nextBefore: value.nextBefore,
      earlierRecordsUnavailable: value.earlierRecordsUnavailable,
      earlierRecordsPruned: value.earlierRecordsPruned,
    }
  }

  change(req) {
    const { service } = this
    const { source, operation, id, teamId } = req
    if (!['update', 'run', 'pause', 'resume', 'delete', 'poll'].includes(operation)) throw new Error('未知自动化操作。')
    if (source === 'message' && operation !== 'poll') {
      const actions = { update: 'Edit', run: 'Run', pause: 'Pause', resume: 'Resume', delete: 'Delete' }
      return teamScheduleAction(service.runtime, {
        action: 'team-workspace.schedule' + actions[operation], id, sessionId: req.sessionId, expectedUpdatedAt: req.updatedAt,
        ...(operation === 'update' ? { title: req.title, prompt: req.instructions,
          target: req.target?.id, ...(req.when ? { when: scheduleOf(req.when, true) } : {}) } : {}),
      })
    }
    if (source === 'routine' && operation !== 'poll') {
      return service.routines.owner({
        action: 'automation.routine.' + operation, teamId, id, revision: req.revision, requestId: req.requestId,
        ...(operation === 'update' ? { title: req.title, criteria: req.instructions, schedule: req.when, ...assignment(req.target) } : {}),
      })
    }
    if (source === 'github' && operation === 'poll')
      return service.automation.owner({ action: 'automation.githubPoll', teamId, id })
    if (['github', 'webhook'].includes(source) && ['pause', 'resume'].includes(operation))
      return service.automation.owner({ action: source === 'github' ? 'automation.githubPause' : 'automation.pauseHook', teamId, id, paused: operation === 'pause' })
    throw new Error('此自动化不支持这个操作。')
  }

  async createOnce(req) {
    const { service } = this
    const requestId = req.requestId
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(requestId)) throw new Error('请提供稳定的创建请求 ID')
    const plan = planAutomation(req)
    const id = req.teamId + '/' + requestId
    const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
    const same = service.store.get(collection, id)
    if (same && same.fingerprint !== fingerprint) throw new Error('此请求 ID 已用于另一项自动化')
    if (this.creating.has(id)) return this.creating.get(id)
    if (same?.result) return { ...same.result, replayed: true }
    if (same) throw new Error('上次创建的结果待核对，请查看自动化列表')
    service.store.put(collection, { id, fingerprint })
    const work = this.create(plan, req.teamId, requestId).catch(error => {
      if (!error.automationMayExist) service.store.remove(collection, id)
      throw error
    }).then(result => {
      const { secret, ...publicResult } = result
      service.store.put(collection, { id, fingerprint, result: publicResult })
      return result
    }).finally(() => this.creating.delete(id))
    this.creating.set(id, work)
    return work
  }

  async create(plan, teamId, requestId) {
    const { service } = this
    const req = { ...plan, teamId, requestId }
    const mode = plan.action === 'team-workspace.scheduleCreate' ? 'messages'
      : plan.action === 'automation.routine.create' ? 'routines' : 'events'
    const result = mode === 'messages' ? await createTeamSchedule(service.runtime, req)
      : mode === 'routines' ? await service.routines.owner(req)
      : await service.automation.owner(req)
    return { version: 1, mode, id: result.id, ...(result.url ? { url: result.url } : {}), ...(result.secret ? { secret: result.secret } : {}) }
  }
}

function assignment(target) {
  if (target?.kind === 'workflow') return { target: 'workflow', workflowId: target.id, workflowRevision: target.revision }
  if (target?.kind === 'task') return { target: 'member', ownerId: target.id }
  throw new Error('请选择派工对象或工作流。')
}
