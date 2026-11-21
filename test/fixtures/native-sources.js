// Owner-facing provenance from a native workbench. The workspace binding, not the
// member name or a caller-supplied team id, determines which rows are visible.
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const collections = { evidence: 'messages', tasks: 'tasks', prompts: 'commands', replies: 'events', turns: 'turns', approvals: 'interactions', memory: 'members' }
const privateSections = Object.keys(collections)
const unavailable = () => new Error('该原生来源或目标会话已不可访问。')

function audience(bridge, req, rt) {
  if (rt !== bridge.rt || bridge.service.closing) throw unavailable()
  const links = bridge.links()
  const link = links.find(l => l.donorBotId === req.targetId || l.donorRoomId === req.targetId)
  if (!link || typeof req.targetId !== 'string' || !req.targetId) throw unavailable()
  const team = bridge.store.require('teams', link.teamId)
  if (link.memberId) {
    const bot = rt.state.bots[link.donorBotId]
    if (link.donorSessionId !== req.sessionId) throw unavailable()
    const member = bridge.store.require('members', link.memberId)
    return { type: 'bot', targetId: bot.id, sessionId: link.donorSessionId, name: bot.name, teamId: team.id, teamName: team.name, memberIds: [member.id], nativeId: member.nativeId, audience: [bot.id], sections: privateSections }
  }
  const room = rt.state.rooms[link.donorRoomId]
  if (rt.sessionOfRoom(room) !== req.sessionId) throw unavailable()
  const memberIds = links.filter(l => l.memberId && l.teamId === team.id && room.members.includes(l.donorBotId)).map(l => l.memberId)
  if (!memberIds.length) throw unavailable()
  return { type: 'room', targetId: room.id, sessionId: req.sessionId, name: room.name, teamId: team.id, teamName: team.name, memberIds, audience: [...room.members].sort(), audienceNames: room.members.map(id => rt.state.bots[id].name), sections: ['evidence'] }
}

const reviewJoin = `LEFT JOIN records v ON v.collection='messages'
  AND json_extract(v.data,'$.replyTo')=r.id
  AND json_extract(v.data,'$.teamId')=json_extract(r.data,'$.teamId')
  AND json_extract(v.data,'$.taskId')=json_extract(r.data,'$.taskId')
  AND json_extract(v.data,'$.acknowledges')='review'`

function sourceRows(store, scope, section, { before, limit = 15, id } = {}) {
  if (!scope.sections.includes(section)) throw unavailable()
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40 ||
      (before != null && (!Number.isSafeInteger(before) || before < 1))) throw new Error('来源分页参数无效。')
  const isReport = section === 'evidence'
  const column = section === 'memory' ? 'r.id' : section === 'tasks' || isReport ? "json_extract(r.data,'$.ownerId')" : "json_extract(r.data,'$.memberId')"
  const allowed = scope.memberIds.map(() => '?').join(',')
  const where = ["r.collection=?", "json_extract(r.data,'$.teamId')=?", column + ' IN (' + allowed + ')']
  const params = [collections[section], scope.teamId, ...scope.memberIds]
  if (before != null) { where.push('r.seq<?'); params.push(before) }
  if (id != null) { where.push('r.id=?'); params.push(id) }
  if (isReport) where.push("json_extract(r.data,'$.kind')='report'")
  if (scope.type === 'room') where.push("json_extract(v.data,'$.status')='accepted'")
  if (section === 'replies') where.push("json_extract(r.data,'$.type')='text'")
  if (section === 'memory') where.push("length(json_extract(r.data,'$.memory'))>0")
  const sql = `SELECT r.data, r.seq ${isReport ? ', v.data AS review' : ''} FROM records r ${isReport ? reviewJoin : ''}
    WHERE ${where.join(' AND ')} ORDER BY r.seq DESC LIMIT ?`
  const found = store.db.prepare(sql).all(...params, limit + 1)
  const rows = found.slice(0, limit).map(entry => {
    const r = JSON.parse(entry.data)
    const row = { section, id: r.id, time: r.createdAt, taskId: r.taskId, turnId: r.turnId, status: r.status }
    switch (section) {
      case 'evidence': {
        const task = store.get('tasks', r.taskId)
        const review = entry.review && JSON.parse(entry.review)
        return { ...row, title: task?.title ?? r.taskId, text: r.text, evidenceRevision: r.evidenceRevision,
          reviewId: review?.id, review: review?.text, status: review?.status ?? 'reported' }
      }
      case 'tasks': return { ...row, taskId: r.id, title: r.title, text: r.criteria }
      case 'memory': return { ...row, title: '成员固定记忆', text: r.memory, time: r.profileUpdatedAt ?? r.createdAt }
      case 'approvals': return { ...row, title: r.type === 'question' ? '提问回执' : '审批回执', text: r.text, decision: r.decision }
      case 'turns': return { ...row, turnId: r.id, title: '原生回合', text: r.text }
      case 'prompts': return { ...row, title: '原生输入', text: r.text }
      case 'replies': return { ...row, title: '原生回复', text: r.text }
    }
  })
  return { rows, next: found.length > limit ? found[limit - 1].seq : null }
}

function selectedRows(store, scope, selected) {
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 30) throw new Error('请选择 1 至 30 条来源。')
  const seen = new Set()
  return selected.map(item => {
    if (typeof item?.id !== 'string' || !item.id || seen.has(item.id)) throw unavailable()
    seen.add(item.id)
    const row = sourceRows(store, scope, item.section, { id: item.id, limit: 1 }).rows[0]
    if (!row) throw unavailable()
    return row
  }).sort((a, b) => a.id.localeCompare(b.id))
}

function preview(store, scope, selected) {
  const rows = selectedRows(store, scope, selected)
  const text = ['原生工作台交接 · ' + scope.teamName, '团队 ID ' + scope.teamId, ...rows.map(row => {
    const lines = [row.title, '来源 ' + row.section + '/' + row.id]
    if (row.taskId) lines.push('任务 ' + row.taskId)
    if (row.turnId) lines.push('回合 ' + row.turnId)
    if (row.evidenceRevision != null) lines.push('证据 R' + row.evidenceRevision)
    if (row.status) lines.push('记录状态 ' + row.status)
    if (row.decision) lines.push('原决定 ' + row.decision)
    lines.push(row.text)
    if (row.review) lines.push('验收记录 ' + row.reviewId, row.review)
    return lines.join('\n')
  })].join('\n\n')
  const id = digest([scope.teamId, scope.type, scope.targetId, scope.sessionId, scope.audience, text])
  return { previewId: id, text, target: scope }
}

function wasAdmitted(session, rpcId) {
  const matches = msg => msg?.source?.kind === 'user' && msg.source.rpcId === rpcId
  return session.snapshotEvents().some(e => (e.type === 'user/message' && matches(e.data)) ||
    (e.type === 'agent/inbox/spliced' && e.data.inserted?.some(matches)))
}

export class NativeSources {
  constructor(bridge) {
    this.bridge = bridge
    this.sending = new Map()
  }

  async handle(req) {
    const bridge = this.bridge
    const rt = await bridge.connect()
    const scope = audience(bridge, req, rt)
    if (req.action === 'legacy.sources') {
      return { target: scope, ...sourceRows(bridge.store, scope, req.section ?? 'evidence', req) }
    }
    const plan = preview(bridge.store, scope, req.selected)
    if (req.action === 'legacy.handoffPreview') return plan
    if (req.action !== 'legacy.handoffConfirm' || plan.previewId !== req.previewId) throw new Error('来源、证据或受众发生变化，请重新预览。')
    if (rt.readOnly()) throw new Error('Bot 团队状态为只读。')
    let work = this.sending.get(plan.previewId)
    if (!work) {
      work = this.commit(rt, req, plan)
      this.sending.set(plan.previewId, work)
    }
    try { return await work } finally { if (this.sending.get(plan.previewId) === work) this.sending.delete(plan.previewId) }
  }

  async commit(rt, req, plan) {
    const { bridge } = this
    const { store } = bridge
    const receipt = store.get('nativeHandoffs', plan.previewId)
    if (receipt?.status === 'sent') return receipt
    await rt.ensureCapabilities(plan.target.sessionId)
    const agent = await rt.resolveAgent(plan.target.sessionId)
    // Recheck privacy, roster and the selected revisions after every asynchronous
    // preparation. The actual inbox insertion is synchronous with the final check.
    const current = preview(store, audience(bridge, req, rt), req.selected)
    if (rt.readOnly() || current.previewId !== plan.previewId) throw new Error('来源、证据或受众发生变化，请重新预览。')
    const saved = receipt ?? store.put('nativeHandoffs', {
      id: plan.previewId, teamId: plan.target.teamId, targetId: plan.target.targetId,
      sessionId: plan.target.sessionId, requestId: randomUUID(), status: 'sending',
    })
    // A crashed Host may have persisted the DSH inbox before the SQLite receipt.
    // A claimed or discarded message still has its insertion in the Session log.
    if (!receipt || !wasAdmitted(agent.session, saved.requestId)) {
      agent.followup(createUserMessage({ source: { kind: 'user', rpcId: saved.requestId },
        content: [{ type: 'text', text: plan.text }] }))
    }
    await rt.ctx.sessions.flush(agent.session)
    return store.update('nativeHandoffs', saved.id, { status: 'sent' })
  }
}
