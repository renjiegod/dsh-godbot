import assert from 'node:assert/strict'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { channel } from './WORK-BOARD.mjs'

export default async function check({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const bot = await host.bot('create-bot', { name: 'Steer Worker', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'Bot ready')
  const call = (endpoint, req) => channel(host, endpoint, req)
  const work = await call('board-action', {
    op: 'create', title: 'ASSIGN_WORK_CONTROL', criteria: 'Apply the user correction',
    owner: bot.id, requestId: 'work-create',
  })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let hold = true
  host.model.reply = async body => {
    const messages = JSON.stringify(body.messages)
    if (messages.includes('ADJUST_THE_PLAN')) return 'Applied the correction in the same task.'
    if (messages.includes('ASSIGN_WORK_CONTROL') && hold) await gate
    return 'First result.'
  }
  try {
    await call('board-action', { id: work.id, version: work.version, op: 'dispatch', requestId: 'work-dispatch' })
    const view = () => call('board-discussion', { id: work.id })
    const binding = await until(async () => (await view()).activeRuns?.[bot.id], 'active discussion target')
    assert.equal(binding.steer, true)
    const post = (body, req, modes) => call('board-comment', {
      id: work.id, op: 'post', body, requestId: req, modes, targets: [bot.id],
    })
    const quiet = await post('@Steer Worker no new work', 'skip', { [bot.id]: { mode: 'note' } })
    assert.equal((await view()).entries.find(entry => entry.id === quiet.commentId).runs.length, 0)
    const steered = await post('@Steer Worker ADJUST_THE_PLAN', 'steer', {
      [bot.id]: { ...binding, mode: 'steer' },
    })
    await until(async () => (await view()).entries.find(entry => entry.id === steered.commentId)?.runs[0]?.state === 'sent'
      || host.model.calls.some(call => JSON.stringify(call.body.messages).includes('ADJUST_THE_PLAN')),
    'comment crossed the session delivery boundary')
    hold = false
    release()
    const settled = await until(async () => {
      const entry = (await view()).entries.find(entry => entry.id === steered.commentId)
      return entry?.runs[0]?.state === 'answered' && entry.runs[0]
    }, 'in-place comment result')
    const task = await until(async () => {
      const item = await call('board-item', { id: work.id })
      return item.phase === 'review' && item
    }, 'assignment stayed attributable')
    assert.match(task.evidence, /Applied the correction/)
    assert.equal(settled.sessionId, task.execution.sessionId)
    assert.equal(settled.turnId, task.execution.turnId)
    assert.equal(task.attempt, 1)
    note('board-comment-steered', { taskId: work.id, attempt: task.attempt, turn: settled.turnId })
  } finally { release() }

  for (const mode of ['queue', 'restart']) {
    const title = 'WORK_CONTROL_' + mode.toUpperCase()
    const directive = 'COMMENT_PAYLOAD_' + mode.toUpperCase()
    const work = await call('board-action', {
      op: 'create', title, owner: bot.id, criteria: 'Follow the written requirements',
      description: 'The specification belongs to this card.', requestId: mode + '-create',
    })
    let unblock
    let isBlocked = true
    const blocked = new Promise(resolve => { unblock = resolve })
    host.model.reply = async body => {
      const messages = JSON.stringify(body.messages)
      if (messages.includes(directive)) {
        assert.match(messages, /The specification belongs to this card/)
        return 'Handled ' + directive
      }
      if (messages.includes(title) && isBlocked) await blocked
      return 'Initial assignment result.'
    }
    try {
      await call('board-action', { id: work.id, version: work.version, op: 'dispatch', requestId: mode + '-dispatch' })
      const view = () => call('board-discussion', { id: work.id })
      const binding = await until(async () => (await view()).activeRuns?.[bot.id], mode + ' active target')
      const runs = async () => (await call('board-runs', { id: work.id })).runs
      const initial = (await runs()).find(run => run.id === binding.runId)
      const post = await call('board-comment', {
        id: work.id, op: 'post', body: '@Steer Worker ' + directive, requestId: mode + '-comment',
        modes: { [bot.id]: { ...binding, mode } }, targets: [bot.id],
      })
      const receipt = async () => (await view()).entries.find(entry => entry.id === post.commentId)?.runs[0]
      if (mode === 'queue') {
        await until(async () => (await receipt())?.state === 'sent', 'comment queued in the original session')
        assert.ok(!host.model.calls.some(call => JSON.stringify(call.body.messages).includes(directive)))
      } else {
        await until(async () => (await runs()).some(run => run.id === initial.id &&
          ['stopped', 'interrupted'].includes(run.status)), 'restart stopped the selected turn')
      }
      isBlocked = false
      unblock()
      const reply = await until(async () => {
        const result = await receipt()
        return result?.state === 'answered' && result
      }, mode + ' comment reply')
      assert.equal(reply.sessionId, initial.sessionId)
      assert.notEqual(reply.turnId, initial.turnId)
      note('board-comment-' + mode, { id: work.id, previousTurn: initial.turnId, nextTurn: reply.turnId })
    } finally { unblock() }
  }

  // Keep the same assignment and discussion attachment when the host, rather
  // than the user, interrupts the Bot's turn.
  const assignmentInput = 'BOARD_HOST_RESTART_ASSIGNMENT'
  const steeredInput = 'BOARD_HOST_RESTART_STEER'
  const commentInput = 'BOARD_HOST_RESTART_COMMENT'
  const firstStepGate = Promise.withResolvers()
  const assignmentGate = Promise.withResolvers()
  const commentGate = Promise.withResolvers()
  let assignmentStarted = false
  let steeredStarted = false
  let commentStarted = false
  host.model.reply = async ({ messages }) => {
    const current = JSON.stringify(messages.findLast(message => message.role === 'user')?.content)
    const history = JSON.stringify(messages)
    if (current.includes('DeepSeek Harness restarted while you were working')) {
      return history.includes(commentInput) ? 'Recovered the discussion response.' : 'Recovered the original assignment.'
    }
    if (current.includes(commentInput)) {
      commentStarted = true
      await commentGate.promise
    } else if (history.includes(steeredInput)) {
      steeredStarted = true
      await assignmentGate.promise
    } else if (current.includes(assignmentInput)) {
      assignmentStarted = true
      await firstStepGate.promise
      return [{ type: 'tool_use', name: 'list_bots', input: { bot: 'Steer Worker' } }]
    }
    return 'Fixture ready.'
  }
  try {
    const work = await call('board-action', { op: 'create', title: assignmentInput, owner: bot.id,
      criteria: 'Return the original assignment result', requestId: 'host-restart-create' })
    await call('board-action', { id: work.id, version: work.version, op: 'dispatch', requestId: 'host-restart-dispatch' })
    await until(() => assignmentStarted, 'the original assignment is working')
    const discussion = () => call('board-discussion', { id: work.id })
    const binding = await until(async () => (await discussion()).activeRuns?.[bot.id], 'the assignment accepts a correction')
    const steered = await call('board-comment', {
      id: work.id, op: 'post', body: '@Steer Worker ' + steeredInput, requestId: 'host-restart-steer',
      modes: { [bot.id]: { ...binding, mode: 'steer' } }, targets: [bot.id],
    })
    const runOf = async post => (await discussion()).entries.find(entry => entry.id === post.commentId)?.runs[0]
    await until(async () => ['sent', 'running'].includes((await runOf(steered))?.state), 'the correction is in the active inbox')
    firstStepGate.resolve()
    const beforeSteer = await until(async () => steeredStarted && await runOf(steered), 'the active assignment received the correction')
    await host.stop('SIGKILL')
    await host.start()
    const reported = await until(async () => {
      const item = await call('board-item', { id: work.id })
      return item.phase === 'review' && item
    }, 'the restarted assignment reaches review')
    assert.equal(reported.attempt, 1)
    assert.match(reported.evidence, /Recovered the original assignment/u)
    const afterSteer = await until(async () => {
      const run = await runOf(steered)
      return run?.state === 'answered' && run
    }, 'the correction receives its reply on the resumed assignment')
    assert.equal(afterSteer.id, beforeSteer.id)
    assert.equal(afterSteer.turnId, reported.execution.turnId)

    const post = await call('board-comment', {
      id: work.id, op: 'post', body: '@Steer Worker ' + commentInput, requestId: 'host-restart-comment', targets: [bot.id],
    })
    const receipt = () => runOf(post)
    const before = await until(async () => commentStarted && await receipt(), 'the attached discussion turn is working')
    await host.restart()
    const after = await until(async () => {
      const run = await receipt()
      return run?.state === 'answered' && run
    }, 'the restarted response returns to its original discussion')
    assert.equal(after.id, before.id)
    assert.equal(after.sessionId, before.sessionId)
    assert.notEqual(after.turnId, before.turnId)
    note('board-host-recovery', { card: work.id, sameAssignment: true, sameSteeredComment: true, sameDiscussion: true })
  } finally {
    firstStepGate.resolve()
    assignmentGate.resolve()
    commentGate.resolve()
  }
}
