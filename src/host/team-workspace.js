import { templateAction } from './team-templates.js'
import { teamScheduleAction } from './team-schedules.js'
export async function teamWorkspace(service, req) {
  const rt = service.runtime
  const { action } = req
  if (action.startsWith('team-workspace.schedule')) return teamScheduleAction(rt, req)
  if (action.startsWith('team-workspace.template')) return templateAction(rt, service, req)
  if (action === 'team-workspace.inbox') {
    const roomOrBot = (bot, room) => room ? (rt.roomOf(room)?.name ?? room) + ' · ' + (rt.botOf(bot)?.name ?? bot) : rt.botOf(bot)?.name
    const approvals = rt.approvalsView().filter(i => i.answerable).map(i => ({
      id: i.id, sessionId: i.sessionId, source: 'bot-approval', type: 'permission', text: i.reason || i.tool,
      details: i.detail?.text ?? i.detail?.code, label: roomOrBot(i.botId, i.roomId), createdAt: new Date(i.at).toISOString(),
      options: [{ id: 'allow', label: '允许一次' }, { id: 'reject', label: '拒绝' }],
    }))
    const questions = Object.entries(rt.state.questions ?? {}).map(([sessionId, q]) => ({
      id: q.id, sessionId, source: 'bot-question', type: 'question', text: q.question,
      label: roomOrBot(rt.selfOf(sessionId), rt.groupOwners.get(sessionId)?.roomId),
      questions: [{ id: 'answer', question: q.question, detail: q.detail, options: q.options, multiSelect: q.multiSelect }],
      createdAt: q.askedAt ? new Date(q.askedAt).toISOString() : undefined,
    }))
    const rooms = Object.values(rt.state.rooms).map(room => ({ id: room.id, name: room.name, enabled: room.godbotAutoRoute === true && room.mode === 'admin' }))
    return { rows: approvals.concat(questions).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')), rooms }
  }
  if (rt.readOnly()) throw new Error('当前 Bot 工作区为只读。')
  if (action === 'team-workspace.routing') {
    const room = rt.state.rooms[req.roomId]
    if (!room || typeof req.enabled !== 'boolean') throw new Error('请选择群组和路由方式。')
    if (req.enabled && (!room.admin || room.mode !== 'admin')) throw new Error('请先在群设置中选择管理员优先，并指定管理员。')
    if (req.enabled) room.godbotAutoRoute = true
    else delete room.godbotAutoRoute
    await rt.save()
    return true
  }
  if (action === 'team-workspace.answer') {
    if (req.source === 'bot-approval') {
      const entry = rt.approvalsView().find(i => i.id === req.id && i.sessionId === req.sessionId && i.answerable)
      if (!entry) throw new Error('这项审批已结束。')
      rt.answerApproval(entry.id, req.decision)
      return true
    }
    if (req.source === 'bot-question') {
      const q = rt.state.questions[req.sessionId]
      if (!q || q.id !== req.id || !Array.isArray(req.answer?.answer)) throw new Error('这个问题已结束或缺少回答。')
      const values = req.answer.answer.filter(s => typeof s === 'string')
      const labels = new Set((q.options ?? []).map(o => o.label))
      return rt.answerQuestion(req.sessionId, q.id, { selected: values.filter(v => labels.has(v)), custom: values.filter(v => !labels.has(v)).join('\n') })
    }
  }
  throw new Error('未知的团队操作。')
}
