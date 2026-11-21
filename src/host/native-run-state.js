const openTurns = new Set(['starting', 'running', 'stopping'])
const openCommands = new Set(['queued', 'writing', 'awaiting-stop', 'awaiting-ack'])

function supersededAssignment(store, turn) {
  const message = store.get('messages', turn.messageId)
  if (message?.kind !== 'assignment') return false
  const task = store.get('tasks', message.taskId)
  return task && task.attempt > message.attempt
}

export function nativeRunState(s, run, tasks) {
  const turns = s.forRun('turns', run.id)
  const commands = s.forRun('commands', run.id)
  const latestTurns = turns.filter((turn) => !supersededAssignment(s, turn))
  const pending = s.forRun('interactions', run.id).filter((i) => ['pending', 'answering'].includes(i.status))
  const outstanding = s.outstandingBotWork?.(tasks) ?? []
  let state = 'running',
    reason = 'Work in progress'
  if (
    latestTurns.some((turn) => turn.status === 'unknown') ||
    tasks.some((task) => task.failure?.kind === 'unknown')
  ) {
    state = 'unknown'
    reason = 'Native completion needs reconciliation'
  } else if (
    tasks.some((task) => ['failed', 'blocked'].includes(task.status)) ||
    latestTurns.some((turn) => ['failed', 'interrupted'].includes(turn.status))
  ) {
    state = 'failed'
    reason = 'A required task failed or was blocked'
  } else if (pending.length || tasks.some((task) => ['reported', 'awaiting-report'].includes(task.status))) {
    state = 'needs_input'
    reason = pending.length ? 'An interaction needs a response' : 'A task needs evidence or owner review'
  } else if (
    tasks.length &&
    tasks.every(task => task.status === 'completed' || (run.workflowId && task.workflowNodeId && task.status === 'skipped')) &&
    !turns.some((turn) => openTurns.has(turn.status)) &&
    !commands.some((cmd) => openCommands.has(cmd.status)) && !outstanding.length
  ) {
    state = 'completed'
    reason = 'All required tasks were accepted'
  } else if (s.require('teams', run.teamId).stopped) {
    state = 'stopped'
    reason = 'Team is stopped'
  } else if (outstanding.some(row => row.budgetHold) || commands.some((c) => c.status === 'queued' && c.budgetHold)) {
    const held = outstanding.find(row => row.budgetHold) ?? commands.find((c) => c.status === 'queued' && c.budgetHold)
    reason =
      'Deferred by ' + held.budgetHold.limit + ' until ' + new Date(held.budgetHold.resetsAt).toISOString()
  }
  return { state, reason, pending }
}
