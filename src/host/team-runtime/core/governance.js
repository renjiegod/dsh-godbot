import { randomUUID } from 'node:crypto'
import { checkOnlyScheduleMarker, delegatedOrigin, mergeRunOrigins, originKinds, runOrigin } from '../../run-origin.js'
import { REPLY_KIND, SOURCE_KIND } from './constants.js'

const AUDIT = 'tool-governance-audit'
const originBook = id => 'origin-' + id
const readTools = new Set([
  'list_bots', 'get_bot', 'read', 'read_file', 'list_files', 'grep', 'glob', 'search_files',
  'read_group_chat', 'read_bot_chat', 'recall', 'web_search', 'web_fetch', 'browser_open',
  'browser_status', 'browser_snapshot', 'browser_screenshot', 'browser_back', 'godbot_desktop_view',
  'list_components', 'show_component', 'show_view', 'ask_user', 'ask_user_question',
])
const toolPattern = /^[a-zA-Z0-9_.:@/-]{1,120}\*?$/

export function isReadTool(tool, args) {
  if (tool === 'browser_tabs') return !args?.action || args.action === 'list'
  return readTools.has(tool)
}

function matchesTool(pattern, tool) {
  return pattern === '*' || pattern === 'changes' && !tool.readOnly || pattern.endsWith('*') && tool.name.startsWith(pattern.slice(0, -1)) || pattern === tool.name
}

function matchingRules(rules, action) {
  const { origin, botId, target } = action
  return rules.filter(rule => rule.enabled &&
    (!rule.botId || rule.botId === botId) &&
    (rule.origin === 'any' || rule.origin === 'unattended' && origin.unattended || rule.origin === origin.kind || rule.origin === origin.rootKind) &&
    (!rule.target || target === rule.target || target?.startsWith(rule.target + '/')) &&
    matchesTool(rule.tool, action))
}

export function decideExecution(rules, action) {
  if (action.origin.readOnly && !action.readOnly) return { decision: 'deny', reason: '此自动化只检查并反馈' }
  const applicable = matchingRules(rules, action)
  const rule = applicable.find(entry => entry.effect === 'deny') ?? applicable.find(entry => entry.effect === 'ask')
  return rule ? { decision: rule.effect, ruleId: rule.id, reason: rule.name } : { decision: 'allow' }
}

function cleanToken(value, max = 160) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : ''
}

function cleanRule(input, rt) {
  const name = cleanToken(input?.name, 100)
  const tool = input?.tool == null || input.tool === '' ? '*' : cleanToken(input.tool)
  const botId = cleanToken(input?.botId)
  const target = cleanToken(input?.target, 512)
  const origin = input?.origin
  if (!name || !['deny', 'ask'].includes(input?.effect) ||
      tool !== '*' && !toolPattern.test(tool) ||
      input?.target && !target || input?.botId && !botId ||
      botId && !rt.botOf(botId) || !['any', 'unattended', ...originKinds].includes(origin)) throw new Error('请输入有效的规则名称、来源、工具及决定')
  if (target && rt.redactSecrets(target) !== target) throw new Error('规则目标包含已保存的凭据')
  return { name, tool, botId, target, origin, effect: input.effect, enabled: input.enabled !== false }
}

export function scheduleOrigin(content, checkIns) {
  const text = (Array.isArray(content) ? content : []).filter(item => item.type === 'text').map(item => item.text).join('\n')
  if (!/^\[SCHEDULE REMINDER(?: BATCH)?\]/.test(text)) return runOrigin('schedule')
  const direct = /^schedule_id_json: ("schedule-[0-9a-f-]{36}")$/m.exec(text)?.[1]
  const readJson = field => {
    try { return JSON.parse(text.split('\n').find(line => line.startsWith(field))?.slice(field.length)) }
    catch { return undefined }
  }
  const batch = readJson('reminders_json: ')
  const reminders = direct
    ? [{ schedule_id: JSON.parse(direct), reminder_prompt: readJson('reminder_prompt_json: ') }]
    : Array.isArray(batch) ? batch.filter(row => /^schedule-[0-9a-f-]{36}$/.test(row?.schedule_id)) : []
  const restricted = reminders.find(row => checkIns?.[row.schedule_id] === true ||
    (typeof row.reminder_prompt === 'string' && row.reminder_prompt.startsWith(checkOnlyScheduleMarker)))
  return runOrigin('schedule', (restricted ?? reminders[0])?.schedule_id, 'owner', Boolean(restricted))
}

function targetOf(rt, botId, tool, args) {
  const value = args?.url ?? args?.path ?? args?.file_path ?? args?.filePath ?? args?.cwd ?? args?.connector
    ?? (/^browser_/.test(tool) ? rt.godbotBrowser?.executionOrigin(botId) : undefined)
  if (typeof value !== 'string') return undefined
  let target = value.trim().slice(0, 512)
  if (URL.canParse(target)) {
    const url = new URL(target)
    target = ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined
  }
  return target && rt.redactSecrets(target) === target ? target : undefined
}

function titleSafe(rt, value) {
  return typeof value === 'string' ? rt.redactSecrets(value).slice(0, 160) : undefined
}

export function install(rt) {
  const active = new Map()
  const pending = new Map()
  let saving = Promise.resolve()
  const rules = () => rt.state.executionPolicies ?? []
  const records = id => rt.ledger.records(originBook(id))

  function messageSource(id, source, content) {
    if (source?.kind === 'schedule') return scheduleOrigin(content, rt.state.scheduleCheckIns)
    if (source?.kind === 'user') {
      const registered = source.rpcId && records(id).findLast(row => row.requestId === source.rpcId)?.origin
      return registered ?? runOrigin('person', undefined, titleSafe(rt, source.principal?.userId) ?? 'owner')
    }
    if (source?.kind === REPLY_KIND) return runOrigin('person')
    if (source?.kind === SOURCE_KIND) {
      if (source.godbotInitiator && originKinds.includes(source.godbotInitiator.kind)) return source.godbotInitiator
      if (source.senderSessionId) return delegatedOrigin(null, source.senderSessionId)
      return runOrigin(source.role === 'kickoff' ? 'service' : 'unknown')
    }
    return undefined
  }

  async function registerPrompt(id, requestId, origin) {
    if (!origin) return
    const book = originBook(id)
    rt.ledger.append(book, { requestId, origin })
    await rt.ledger.written(book)
  }

  function current(id) {
    if (active.has(id)) return active.get(id) ?? runOrigin('unknown')
    return records(id).findLast(row => row.kind === 'turn')?.origin ?? runOrigin('unknown')
  }

  function keep(id, origin) {
    active.set(id, origin)
    if (rt.readOnly()) return
    rt.ledger.append(originBook(id), { kind: 'turn', origin })
  }

  rt.ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (!id || !rt.selfOf(id) && !rt.roomOf(id)) return
    if (event.type === 'turn/start') {
      keep(id, pending.get(id) ?? null)
      pending.delete(id)
    } else if (event.type === 'user/message') {
      const origin = messageSource(id, event.data?.source, event.data?.content)
      if (!origin) return
      if (active.has(id) || rt.live?.get(id)?.turn !== undefined) {
        keep(id, mergeRunOrigins(active.get(id), origin))
      } else pending.set(id, mergeRunOrigins(pending.get(id), origin))
    } else if (event.type === 'turn/end') {
      keep(id, null)
      active.delete(id)
    }
  }, { prepend: true })

  function boundSession(agent) {
    const session = agent?.session
    let id = session?.id ?? agent?.id
    let parent = session?.header?.parentSession
    for (let depth = 0; depth < 12 && id; depth += 1) {
      if (rt.selfOf(id)) return id
      if (!parent || parent === id) break
      id = parent
      parent = rt.ctx.get?.('sessions')?.get(id)?.header?.parentSession
    }
    return undefined
  }

  async function audit(action, result, phase, effect) {
    rt.ledger.append(AUDIT, {
      ...action, ...result, phase, ...(effect ? { effect } : {}),
      id: randomUUID(), time: Date.now(),
    })
    await rt.ledger.written(AUDIT)
  }

  async function authorize(action, exec, next) {
    const result = decideExecution(rules(), action)
    await audit(action, result, 'decision')
    if (result.decision === 'deny') throw new Error('工作区执行策略已拒绝 · ' + result.reason)
    if (result.decision === 'ask') {
      const approval = rt.ctx.get?.('approval')
      if (!approval || !exec?.agent?.session) throw new Error('该操作需要工作区审批，请从可审批的 Bot 会话执行')
      const answer = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
        reason: result.reason + ' · ' + action.origin.kind + ' · ' + action.name })
      const granted = answer === 'allowed-once'
      await audit(action, result, 'answer', granted ? 'approved' : 'declined')
      if (!granted) throw new Error('工作区执行策略的审批未通过')
      const now = decideExecution(rules(), action)
      if (now.decision === 'deny' || now.decision === 'ask' && now.ruleId !== result.ruleId) {
        await audit(action, now, 'rechecked')
        throw new Error('审批等待期间执行策略已改变，请重试')
      }
    }
    exec?.signal?.throwIfAborted()
    if (!next) return
    try {
      const worked = await next()
      if (worked?.isError) await audit(action, result, 'execution', 'failed').catch(() => {})
      return worked
    } catch (failure) {
      await audit(action, result, 'execution', 'failed').catch(() => {})
      throw failure
    }
  }

  rt.ctx.on('tools/execute', async (exec, next) => {
    const id = boundSession(exec.agent)
    if (!id || rt.readOnly()) return next()
    const botId = rt.selfOf(id)
    const args = exec.arguments
    return authorize({
      sessionId: id, botId, origin: current(id), name: exec.name,
      target: targetOf(rt, botId, exec.name, args), readOnly: isReadTool(exec.name, args),
    }, exec, next)
  }, { prepend: true })

  function page(req, limit = 100) {
    const filter = ['decision', 'botId', 'origin'].map(key => [key, cleanToken(req[key])])
    return rt.ledger.records(AUDIT).filter(row => filter.every(([key, value]) => {
      if (!value) return true
      if (key === 'origin') return value === 'unattended' ? row.origin.unattended : row.origin.kind === value || row.origin.rootKind === value
      return row[key] === value
    })).slice(-limit).reverse()
  }

  async function handle(req) {
    await rt.load()
    if (req.action === 'governance.view') return { version: 1, rules: rules(), audit: page(req), origins: originKinds }
    if (req.action === 'governance.export') return { version: 1, audit: page(req, 5000) }
    if (req.action === 'governance.preview') {
      const kind = originKinds.includes(req.origin) ? req.origin : 'unknown'
      const name = cleanToken(req.tool) || 'unknown'
      return decideExecution(rules(), { name, readOnly: isReadTool(name), botId: req.botId,
        target: cleanToken(req.target, 512), origin: runOrigin(kind) })
    }
    const write = saving.then(() => changeRule(req))
    saving = write.catch(() => {})
    return write
  }

  async function changeRule(req) {
    const before = rules()
    const at = req.id === undefined ? -1 : before.findIndex(row => row.id === req.id)
    if (req.id !== undefined && at === -1) throw new Error('该执行策略已不存在')
    if (req.action === 'governance.save') {
      if (at === -1 && before.length >= 100) throw new Error('执行策略目录已满')
      const rule = { id: before[at]?.id ?? randomUUID(), ...cleanRule(req.rule, rt) }
      rt.state.executionPolicies = at === -1 ? [...before, rule] : before.map((row, index) => index === at ? rule : row)
    } else if (req.action === 'governance.remove' && at !== -1) {
      rt.state.executionPolicies = before.filter(row => row.id !== req.id)
    } else throw new Error('未知的执行策略操作')
    try { await rt.save({ required: true }) }
    catch (failure) { rt.state.executionPolicies = before; throw failure }
    return { version: 1, rules: rules(), audit: page(req), origins: originKinds }
  }

  // The origin of the turn under way, or of the last turn that had one.
  const lastOrigin = id => active.get(id) ?? records(id).findLast(row => row.kind === 'turn' && row.origin)?.origin

  rt.governance = {
    handle, registerPrompt, messageSource, current, lastOrigin,
    delegate: (id, botId) => delegatedOrigin(lastOrigin(id), botId),
    nativePreset(id) {
      const origin = current(id)
      if (origin.readOnly) return 'read-only'
      const applicable = matchingRules(rules(), { name: 'approve_agent_action', botId: rt.selfOf(id), origin, readOnly: false })
      if (applicable.some(rule => rule.effect === 'deny' && ['*', 'changes'].includes(rule.tool))) return 'read-only'
      if (applicable.length) return 'workspace-write'
    },
    remote: (id, target, signal) => authorize({
      sessionId: id, botId: rt.selfOf(id), origin: current(id), name: 'remote_agent', target, readOnly: false,
    }, { name: 'remote_agent', agent: rt.ctx.get?.('agents')?.get(id), signal }),
  }
}
