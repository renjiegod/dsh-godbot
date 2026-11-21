import { createHash, randomUUID } from 'node:crypto'
import { nativeRunState } from './native-run-state.js'
import { startWorkflowSnapshot } from './workflows.js'
import { activeTeam, now, record, required } from './team.js'

export class AutomationError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

export function submitRun(service, principal, requestId, input, eventHash) {
  if (service.closing) throw new AutomationError(503, 'Host is stopping')
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 256)
    throw new AutomationError(400, 'A request ID of 1 to 256 characters is required')
  const workflow = Object.hasOwn(input, 'workflowId') || Object.hasOwn(input, 'revision')
  if (workflow && (Object.keys(input).some(key => !['workflowId', 'revision', 'requestId'].includes(key)) ||
      !Number.isSafeInteger(input.revision) || input.revision < 1 || typeof input.workflowId !== 'string' || !input.workflowId.trim()))
    throw new AutomationError(400, 'A workflow run takes only workflowId, a positive integer revision and requestId')
  const title = workflow ? undefined : required(input.title, 'Task title')
  const criteria = workflow ? undefined : required(input.criteria, 'Acceptance criteria')
  if (input.ownerId != null && typeof input.ownerId !== 'string')
    throw new AutomationError(400, 'Invalid member')
  const fingerprint = sha256(JSON.stringify(workflow
    ? ['workflow', input.workflowId, input.revision]
    : [input.ownerId ?? null, title, criteria, eventHash ?? null]))
  const receiptId = JSON.stringify([principal.id, requestId])
  const { store } = service
  return store.transaction(() => {
    const previous = store.get('automationRequests', receiptId)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AutomationError(409, 'Request ID already used for different input')
      return { runId: previous.runId, teamId: principal.teamId, ...(workflow ? { workflowId: input.workflowId, workflowRevision: input.revision } : {}) }
    }
    if (service.runtime?.readOnly()) throw new AutomationError(409, 'Bot workspace is read-only')
    let result
    if (workflow) {
      const saved = store.get('workflows', input.workflowId)
      if (!saved || saved.teamId !== principal.teamId) throw new AutomationError(404, 'Unknown workflow')
      if (input.revision !== saved.revision) throw new AutomationError(409, 'Workflow revision changed. Reload before running it.')
      const run = startWorkflowSnapshot(service, saved, principal.id)
      result = { runId: run.id, teamId: run.teamId, workflowId: run.workflowId, workflowRevision: run.workflowRevision }
    } else {
      result = assignRun(service, principal, { ownerId: input.ownerId, title, criteria }, eventHash ? input.event : undefined)
    }
    store.put('automationRequests', { id: receiptId, fingerprint, runId: result.runId })
    return result
  })
}

// The caller owns the transaction containing the trigger receipt and this assignment.
export function assignRun(service, principal, { ownerId, title, criteria }, event) {
  const team = activeTeam(service.store, principal.teamId)
  const id = randomUUID()
  const task = service.team.assign({ teamId: team.id, ownerId: ownerId || team.leadId, title, criteria }, null, id, event)
  service.store.put('automationRuns', record({ id, teamId: team.id, rootTaskId: task.id, principalId: principal.id }))
  return { runId: id, teamId: team.id }
}

export function inspectRun(service, principal, runId, includeEvidence = false) {
  const s = service.store
  const run = s.get('automationRuns', runId)
  if (!run || run.targetId || run.teamId !== principal.teamId) throw new AutomationError(404, 'Unknown run')
  const tasks = s.forRun('tasks', run.id)
  // Re-evaluate the live roster, including delegated work, before returning
  // evidence through a credential issued while a Bot was public.
  if (tasks.some(task => s.get('members', task.ownerId)?.teamId !== run.teamId))
    throw new AutomationError(404, 'A Bot for this run is no longer accessible')
  const { state, reason, pending } = nativeRunState(s, run, tasks)
  const result = {
    runId: run.id,
    teamId: run.teamId,
    rootTaskId: run.rootTaskId,
    ...(run.workflowId ? { workflowId: run.workflowId, workflowRevision: run.workflowRevision, rootTaskIds: run.rootTaskIds } : {}),
    createdAt: run.createdAt,
    state,
    reason,
    tasks: tasks.map((task) => ({
      id: task.id,
      ...(task.workflowNodeId ? { workflowNodeId: task.workflowNodeId, dependsOn: task.dependsOn } : {}),
      parentTaskId: task.parentTaskId ?? null,
      ownerId: task.ownerId,
      title: task.title,
      status: task.status,
      revision: task.revision,
      evidenceRevision: task.evidenceRevision,
      reviewedEvidenceRevision: task.reviewedEvidenceRevision ?? null,
      attempt: task.attempt,
    })),
    pending: pending.map(({ id, turnId, type }) => ({ id, turnId, type })),
  }
  if (includeEvidence) {
    if (run.workflowId) result.workflowDefinition = s.require('workflowRuns', run.id).definition
    const reports = s.forRun('messages', run.id).filter(m => m.kind === 'report' || m.acknowledges === 'review')
    const sources = new Set([
      ...(result.workflowDefinition?.nodes.map(node => node.ownerId) ?? []),
      ...reports.flatMap(message => [message.from, ...message.to]),
    ])
    if ([...sources].some(id => id !== 'user' && s.get('members', id)?.teamId !== run.teamId))
      throw new AutomationError(404, 'A Bot for this run is no longer accessible')
    result.reports = reports.map((m) => ({
      id: m.id,
      taskId: m.taskId,
      kind: m.kind,
      revision: m.evidenceRevision,
      at: m.createdAt,
      decision: m.status,
      evidence: m.evidence ?? m.text,
      replyTo: m.replyTo,
    }))
    result.exportedAt = now()
  }
  return result
}
