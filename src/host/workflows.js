import { activeTeam, now, record, required } from './team.js'
import { nativeRunState } from './native-run-state.js'
import { compileWorkflow, normalizeWorkflow } from '../team/workflow-graph.js'

function allowedOwners(store, teamId) {
  return new Set(store.all('members').filter(member => member.teamId === teamId).map(member => member.id))
}

function viewRun(store, run) {
  const tasks = store.forRun('tasks', run.id)
  const byNode = new Map(tasks.map(task => [task.workflowNodeId, task]))
  const nodes = run.definition.nodes.map(node => {
    const task = byNode.get(node.id)
    return { nodeId: node.id, taskId: task.id, title: task.title, ownerId: task.ownerId, status: task.status,
      evidence: task.evidence, evidenceRevision: task.evidenceRevision, attempt: task.attempt }
  })
  const { state, reason, pending } = nativeRunState(store, run, tasks)
  const status = ({ needs_input: 'needs-review', failed: 'blocked' })[state] ?? state
  return { ...run, status, reason, pending: pending.map(({ id, turnId, type }) => ({ id, turnId, type })), nodes }
}

export function listWorkflows(store, teamId) {
  store.require('teams', teamId)
  return {
    workflows: store.all('workflows').filter(workflow => workflow.teamId === teamId).reverse(),
    runs: store.all('workflowRuns').filter(run => run.teamId === teamId).reverse().map(run => viewRun(store, run)),
  }
}

export function saveWorkflow(store, req) {
  activeTeam(store, req.teamId)
  const prior = req.id === undefined ? null : store.require('workflows', req.id)
  if (prior && prior.teamId !== req.teamId) throw new Error('Workflow does not belong to this team')
  if (prior && prior.revision !== req.expectedRevision) throw new Error('Workflow revision changed. Reopen it before saving.')
  const definition = normalizeWorkflow(req, allowedOwners(store, req.teamId))
  return store.put('workflows', record({ ...prior, ...definition, teamId: req.teamId,
    revision: (prior?.revision ?? 0) + 1, updatedAt: now() }))
}

// The owner RPC stores the request receipt, this snapshot, every task and initial dispatch in one transaction.
export function startWorkflow(service, req) {
  const { store } = service
  required(req.requestId, 'Run request ID')
  activeTeam(store, req.teamId)
  const workflow = store.require('workflows', req.id)
  if (workflow.teamId !== req.teamId) throw new Error('Workflow does not belong to this team')
  if (req.expectedRevision !== workflow.revision) throw new Error('Workflow revision changed. Reload before running it.')
  return startWorkflowSnapshot(service, workflow, 'owner')
}

// The scheduler keeps its selected revision even when an owner edits the definition for future runs.
export function startWorkflowSnapshot(service, workflow, principalId) {
  const { store } = service
  activeTeam(store, workflow.teamId)
  const { nodes, edges, incoming, order } = compileWorkflow(workflow, allowedOwners(store, workflow.teamId))
  const run = store.put('workflowRuns', record({ workflowId: workflow.id,
    workflowRevision: workflow.revision, name: workflow.name, teamId: workflow.teamId, definition: { nodes, edges } }))
  const byId = new Map(nodes.map(node => [node.id, node]))
  const taskIds = new Map()
  for (const id of order) {
    const node = byId.get(id)
    const inputs = incoming.get(id).map(edge => ({ taskId: taskIds.get(edge.from), when: edge.when, value: edge.value }))
    const task = service.team.assign({ teamId: run.teamId, ownerId: node.ownerId, title: node.title,
      criteria: node.criteria, dependsOn: inputs.map(input => input.taskId) }, null, run.id, undefined,
      { workflowNodeId: id, workflowJoin: node.join, workflowInputs: inputs })
    taskIds.set(id, task.id)
  }
  const rootTaskIds = order.filter(id => incoming.get(id).length === 0).map(id => taskIds.get(id))
  store.put('automationRuns', record({ id: run.id, teamId: run.teamId, principalId,
    rootTaskId: rootTaskIds[0], rootTaskIds, workflowId: run.workflowId, workflowRevision: run.workflowRevision }))
  return viewRun(store, run)
}
