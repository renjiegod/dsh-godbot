import { botWorkspaceId, pendingFor } from './bot-task-workspace.js'
import { taskBudgetReceipt } from './bot-budget.js'
import { millis } from './work-board-index.js'
import { lifecycleDetail, lifecycleSummary } from './work-board-lifecycle.js'

const clip = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
const refsOf = (values) => [...new Set(values.filter(Boolean))].sort()
const target = (kind, id) => id && kind + '/' + id
const originRefs = (origin) => refsOf([target('room', origin?.roomId), target('bot', origin?.botId)])
function when(phase, mark, needs = false) {
  return { phase, mark, needs }
}

function runInteractions(rt, rows) {
  const result = []
  for (const r of rows) {
    const botId = r.targetId?.startsWith('bot/') ? r.targetId.slice(4) : undefined
    const roomId = r.targetId?.startsWith('room/') ? r.targetId.slice(5) : undefined
    if (r.questionId && rt.state.questions?.[r.questionSession]?.id === r.questionId)
      result.push({ id: r.questionId, type: 'question', sessionId: r.questionSession, botId, roomId })
    for (const a of rt.approvalsView?.() ?? []) {
      const info = rt.live?.get(a.sessionId)?.info
      if (r.workId && (rt.workOf?.(info) ?? info?.exchangeId) === r.workId)
        result.push({ id: a.id, type: 'approval', sessionId: a.sessionId, botId, roomId })
    }
  }
  return result
}

function summarizeSource(service, row, meta) {
  const { store, runtime: rt } = service
  const base = {
    title: meta.title,
    owner: meta.owner || null,
    room: meta.room || meta.origin?.roomId || null,
    source: row.kind,
    refs: originRefs(meta.origin),
    hint: '',
    updated: meta.updated || 0,
    version: String(meta.version || 1),
  }
  if (base.room) base.refs.push('room/' + base.room)
  if (row.kind === 'work') return { ...base, ...lifecycleSummary(meta) }
  if (row.kind === 'draft') {
    if (base.owner) base.refs.push('bot/' + base.owner)
    return {
      ...base,
      ...when(meta.archived ? 'history' : 'todo', meta.archived ? 'archived' : 'draft'),
      hint: clip(meta.criteria),
    }
  }
  if (row.kind === 'room') {
    const task = rt.state.rooms?.[row.scope]?.tasks?.[row.source_id]
    if (!task) return null
    const states = {
      active: when('doing', 'selfActive'),
      review: when('review', 'roomReview', true),
      blocked: when('attention', 'blocked'),
      done: when('done', 'selfDone'),
      cancelled: when('history', 'cancelled'),
    }
    return {
      ...base,
      ...(states[task.status] ?? when('attention', 'unknown', true)),
      title: task.goal,
      owner: task.botId,
      refs: ['room/' + row.scope, 'bot/' + task.botId],
      room: row.scope,
      updated: millis(task.updatedAt || task.startedAt),
      version: String(task.updatedAt) + ':' + task.status + ':' + (task.notes?.length || 0),
      hint: clip(task.result || task.reason || task.progress),
    }
  }
  if (row.kind === 'run') {
    const run = store.get('automationRuns', row.source_id)
    if (!run?.targetId || run.teamId !== botWorkspaceId) return null
    const all = store.forRun('fullTeamTasks', run.id),
      current = all.filter((t) => t.attempt === run.attempt)
    if (!current.length) return null
    const refs = refsOf([run.targetId, ...all.map((t) => t.targetId)].filter((s) => !s.startsWith('subagent/')))
    const failed = current.find((t) => ['unknown', 'failed', 'stopped'].includes(t.status))
    const pending = runInteractions(rt, current).length > 0
    const reports = current.filter((t) => t.status === 'reported')
    const status = failed
      ? when('attention', failed.status, true)
      : pending
        ? when('attention', 'interaction', true)
        : reports.length
          ? when('review', 'reported', true)
          : current.every((t) => t.status === 'completed')
            ? when('done', 'accepted')
            : when('doing', 'working')
    return {
      ...base,
      ...status,
      title: run.title,
      owner: run.targetId.startsWith('bot/') ? run.targetId.slice(4) : null,
      room: run.targetId.startsWith('room/') ? run.targetId.slice(5) : null,
      refs,
      source: 'run',
      version: [
        run.attempt,
        ...current.map((t) => [t.id, t.status, t.evidenceRevision].join('/')),
        String(pending),
      ].join(':'),
      hint: clip(failed?.detail || (reports.length && reports.length + ' 项交付等待验收') || run.criteria),
      updated: Math.max(millis(run.createdAt), millis(service.boardRunTime?.get(run.id)?.at)),
    }
  }
  const task = store.get('tasks', row.source_id)
  if (!task || task.teamId !== botWorkspaceId) return null
  const d = store.get('botTaskDeliveries', task.assignmentId),
    pending = pendingFor(rt, d)
  const held = taskBudgetReceipt(store, d?.sessionId, d?.id)?.status === 'held'
  const info = d?.sessionId && rt.live?.get(d.sessionId)
  const active = !!info?.turn && (rt.workOf?.(info.info) ?? info.info?.exchangeId) === d.id
  const progress = task.boardProgress?.assignmentId === task.assignmentId ? task.boardProgress : null
  const open = ['assigned', 'working', 'awaiting-report', 'reported'].includes(task.status)
  let state
  if (open && (pending.length || held)) state = when('attention', held ? 'budget' : 'interaction', true)
  else if (task.status === 'reported') state = when('review', 'reported', true)
  else if (open && progress?.blocked) state = when('attention', 'blocked')
  else if (task.status === 'assigned')
    state = active || progress ? when('doing', 'working') : when('todo', d?.state === 'sent' ? 'sent' : 'queued')
  else {
    const states = {
      waiting: when('todo', task.dependsOn?.length ? 'dependencies' : 'waiting'),
      working: when('doing', 'working'),
      'awaiting-report': when('doing', 'awaitingReport'),
      transferring: when('doing', 'transferring'),
      completed: when('done', 'accepted'),
      skipped: when('history', 'skipped'),
      blocked: when('attention', 'blocked'),
      failed: when('attention', task.failure?.kind || 'failed', true),
    }
    state = states[task.status] ?? when('attention', 'unknown', true)
  }
  const deps = (task.dependsOn ?? []).map((id) => store.get('tasks', id)?.ownerId)
  const actors = (service.boardParties?.all(task.id) ?? [])
    .flatMap((r) => [r.sender, r.recipient])
    .filter((id) => id && id !== 'user')
  const refs = refsOf([
    ...base.refs,
    'bot/' + task.ownerId,
    ...actors.map((id) => 'bot/' + id),
    ...deps.filter(Boolean).map((id) => 'bot/' + id),
    task.requesterId && task.requesterId !== 'user' ? 'bot/' + task.requesterId : null,
  ])
  const last = service.boardLastMessage?.get(task.id)
  return {
    ...base,
    ...state,
    title: task.title,
    owner: task.ownerId,
    refs,
    source: task.workflowNodeId ? 'workflow' : 'task',
    version: [task.revision, task.evidenceRevision, task.attempt, base.version, state.mark].join(':'),
    hint: clip(task.failure?.reason || task.evidence || progress?.text || task.rework || task.criteria),
    updated: Math.max(
      base.updated,
      millis(task.updatedAt || task.createdAt),
      millis(last?.at),
      millis(progress?.at),
    ),
  }
}

export function sourceSummary(service, row, meta) {
  const source = summarizeSource(service, row, meta)
  if (!source) return null
  const draft = row.kind === 'draft'
  source.title = meta.title ?? source.title
  source.updated = Math.max(source.updated ?? 0, meta.updated ?? 0)
  source.version += ':' + (meta.version ?? 0)
  source.assignee = meta.assignee || (source.owner ? 'bot/' + source.owner : '')
  source.startDate = meta.startDate ?? ''
  source.dueDate = meta.dueDate ?? ''
  source.labels = meta.labels ?? []
  source.customValues = meta.customValues ?? {}
  source.parent = meta.parent ?? ''
  if (meta.assignee?.startsWith('room/')) source.refs.push(meta.assignee)
  if (meta.snapshot?.refs?.length) source.refs.push(...meta.snapshot.refs)
  if (meta.duplicateOf) Object.assign(source, when('history', 'duplicate'))
  else if (draft && !meta.archived && meta.statusPhase) {
    Object.assign(source, when(meta.statusPhase, meta.statusId === 'done' ? 'manualDone' : 'manual'))
  }
  if (draft && meta.dispatchPending && !meta.archived && !meta.duplicateOf)
    Object.assign(source, meta.dispatchError ? when('attention', 'failed', true) : when('todo', 'dependencies'))
  if (meta.dispatchError && draft) source.hint = meta.dispatchError
  source.statusId = meta.statusPhase === source.phase ? meta.statusId || '' : ''
  return source
}

function pageEvents(rows, convert) {
  const events = rows.slice(0, 40)
  return {
    events: events.map((r) => convert(JSON.parse(r.data))).reverse(),
    eventNext: rows.length > 40 ? events.at(-1).seq : null,
  }
}
export function sourceDetail(service, row, meta, card, before = Number.MAX_SAFE_INTEGER) {
  const { store, runtime: rt } = service
  const detail = {
    ...card,
    criteria: meta.criteria || '',
    origin: meta.origin ?? null,
    events: [],
    dependencies: [],
    children: [],
    actions: [],
    pending: [],
  }
  if (row.kind === 'work') return lifecycleDetail(service, row, meta, detail, before)
  if (row.kind === 'draft') {
    detail.actions = meta.archived ? [] : ['edit', 'dispatch', 'archive']
    return detail
  }
  if (row.kind === 'room') {
    const t = rt.state.rooms[row.scope].tasks[row.source_id]
    const notes = t.notes ?? [],
      end = Math.min(before, notes.length),
      start = Math.max(0, end - 40)
    return {
      ...detail,
      origin: { roomId: row.scope },
      evidence: t.result || '',
      eventNext: start || null,
      events: notes
        .slice(start, end)
        .map((n) => ({
          text: n.text,
          at: n.at,
          kind: n.requestId && !n.delivered ? 'note-delivery-unconfirmed' : 'note',
        })),
      actions: ['active', 'review', 'blocked'].includes(t.status) ? ['note', 'cancel'] : [],
    }
  }
  if (row.kind === 'run') {
    const run = store.require('automationRuns', row.source_id),
      evidence = store.forRun('fullTeamEvidence', run.id)
    const current = store.forRun('fullTeamTasks', run.id).filter((t) => t.attempt === run.attempt)
    const children = current.map((t) => ({
      id: t.id,
      target: t.targetId,
      status: t.status,
      attempt: t.attempt,
      evidenceRevision: t.evidenceRevision,
      evidence:
        evidence.findLast((e) => e.taskId === t.id && e.kind === 'report' && e.attempt === t.attempt)?.evidence ||
        '',
    }))
    const report = evidence.findLast((e) => e.receipt?.sessionId && e.attempt === run.attempt)
    const receipt = report?.receipt,
      targetId = children.find((c) => c.id === report?.taskId)?.target
    const execution =
      receipt && targetId?.startsWith('bot/')
        ? { sessionId: receipt.sessionId, turnId: receipt.turnId, botId: targetId.slice(4) }
        : receipt && targetId?.startsWith('room/')
          ? { sessionId: receipt.sessionId, roomId: targetId.slice(5) }
          : null
    return {
      ...detail,
      criteria: meta.criteria ?? run.criteria,
      attempt: run.attempt,
      children,
      execution,
      pending: runInteractions(rt, current),
      origin: card.room ? { roomId: card.room } : null,
      ...pageEvents(service.boardRunEvents.all(run.id, before), (e) => ({
        kind: e.kind,
        at: e.createdAt,
        attempt: e.attempt,
        text: e.evidence,
        version: e.revision,
      })),
      actions: card.phase === 'review' ? ['approve', 'reject'] : [],
    }
  }
  const t = store.require('tasks', row.source_id),
    d = store.get('botTaskDeliveries', t.assignmentId)
  const actions = []
  if (card.phase === 'review') actions.push('approve', 'reject')
  if (t.status === 'failed') actions.push('retry')
  if (
    ['assigned', 'working', 'awaiting-report', 'waiting', 'blocked', 'reported', 'failed'].includes(t.status) &&
    !['sent', 'sending'].includes(d?.state)
  )
    actions.push('transfer')
  return {
    ...detail,
    criteria: t.criteria,
    evidence: t.evidence || '',
    review: t.review || '',
    failure: t.failure,
    pending: pendingFor(rt, d).map((p) => ({ ...p, sessionId: d.sessionId, botId: t.ownerId })),
    evidenceRevision: t.evidenceRevision,
    revision: t.revision,
    attempt: t.attempt,
    taskId: t.id,
    assignmentId: t.assignmentId,
    execution: d?.sessionId ? { botId: t.ownerId, sessionId: d.sessionId, turnId: d.turnId } : null,
    dependencies: t.dependsOn ?? [],
    ...pageEvents(service.boardMessages.all(t.id, before), (e) => {
      const delivery = store.get('botTaskDeliveries', e.kind === 'assignment' ? e.id : e.replyTo)
      return {
        kind: e.kind,
        at: e.createdAt,
        text: e.text,
        attempt: e.attempt,
        version: e.evidenceRevision,
        ...(delivery?.sessionId
          ? { execution: { botId: delivery.botId, sessionId: delivery.sessionId, turnId: delivery.turnId } }
          : {}),
      }
    }),
    actions,
  }
}
