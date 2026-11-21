import { createHash } from 'node:crypto'
import { normalizeRoutineTiming } from './routine-timing.js'
import { createTeamSchedule } from './team-schedules.js'
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

export function planAutomation(req) {
  const target = req.target
  const trigger = req.trigger
  if (!['message', 'task', 'workflow'].includes(target?.kind) || !['schedule', 'webhook', 'github'].includes(trigger?.kind)) {
    throw new Error('请选择自动化执行对象和触发方式')
  }
  const title = required(req.title, '任务名称')
  if (title.length > 120) throw new Error('任务名称最多 120 字')
  const checkOnly = req.checkOnly === true
  const workflow = target.kind === 'workflow'
  const message = target.kind === 'message'
  const targetId = required(target.id, workflow ? '工作流' : message ? '会话' : 'Bot')
  const description = workflow ? '' : required(req.instructions, message ? '指令' : '验收条件')
  if (description.length > 16_000) throw new Error('指令最多 16000 字')
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
    const { service } = this
    if (req.action === 'automation.setup.view') {
      const runtime = service.runtime
      await runtime.load()
      const schedules = await runtime.scheduleEndpoint('schedules', {})
      const { workflows } = service.routines.owner({ action: 'automation.routine.list', teamId: req.teamId })
      return { version: 1, available: schedules.available, workflows }
    }
    if (req.action !== 'automation.setup.create') throw new Error('未知自动化设置操作')
    const requestId = req.requestId
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(requestId)) throw new Error('请提供稳定的创建请求 ID')
    const plan = planAutomation(req)
    const id = req.teamId + '/' + requestId
    const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
    const same = service.store.get(collection, id)
    if (same && same.fingerprint !== fingerprint) throw new Error('此请求 ID 已用于另一项自动化')
    if (this.creating.has(id)) return this.creating.get(id)
    if (same?.result) return { ...same.result, replayed: true }
    if (same) throw new Error('上次创建的结果待核对，请查看对应自动化列表')
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
