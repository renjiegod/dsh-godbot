import assert from 'node:assert/strict'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { until } from '../host.mjs'
import { channel } from './WORK-BOARD.mjs'

const submit = (name, input) => [{ type: 'tool_use', name, input }]

export default async function check({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const lead = await host.bot('create-bot', { name: 'Lifecycle Lead', model: 'deepseek-official/deepseek-flash' })
  const worker = await host.bot('create-bot', { name: 'Lifecycle Verifier', model: 'deepseek-official/deepseek-flash' })
  const chat = bot => host.bot('chat', { botId: bot.id })
  await until(async () => (await chat(lead)).items.some(i => i.kind === 'bot') &&
    (await chat(worker)).items.some(i => i.kind === 'bot'), 'both Bots are ready')
  const view = (search = '') => channel(host, 'board-view', { search })
  const find = async title => (await view(title)).columns.flatMap(column => column.items).find(card => card.title === title)
  const inspect = id => channel(host, 'board-item', { id })
  const action = (card, op, requestId, fields = {}) => channel(host, 'board-action', {
    id: card.id, version: card.version, evidenceRevision: card.evidenceRevision, op, requestId, ...fields,
  })
  const send = (bot, text, requestId) => host.bot('send', { sessionId: bot.id, text, requestId })
  const cardIn = (id, status) => until(async () => {
    const card = await inspect(id)
    return card.lifecycleState === status && card
  }, id + ' reaches ' + status)

  const title = 'LIFECYCLE_REQUEST verify the sample calculation'
  const childTitle = 'LIFECYCLE_CHILD verify the second addition'
  let release
  const gate = new Promise(resolve => { release = resolve })
  let sawGate = false
  let delegated = false
  let ask = true
  let revised = false
  host.model.reply = async (body, call) => {
    const input = JSON.stringify(body.messages)
    if (input.includes('LIFECYCLE_DISCUSSION')) return 'The delegated verification checked a second equation.'
    if (input.includes(childTitle) && call.sessionId !== lead.id) return 'Verification evidence: 3 + 4 equals 7.'
    if (input.includes('LIFECYCLE_CORRECTION')) {
      revised = true
      return 'Revised evidence: 2 + 5 equals 7 and 3 + 4 equals 7.'
    }
    if (input.includes(title) && ask) {
      sawGate = true
      await gate
      ask = false
      return submit('ask_user', { question: 'Which input should we check?', options: [{ label: 'Sample A' }, { label: 'Sample B' }] })
    }
    if (input.includes('answer_to_pending_question') && !delegated) {
      delegated = true
      return submit('message_bot', { to: worker.name, message: childTitle, title: childTitle, work_intent: 'delegate',
        acceptance: 'Return a second equation that totals 7.', request_id: 'lifecycle-child-delivery' })
    }
    if (input.includes('answer_to_pending_question') || input.includes('Verification evidence:'))
      return 'Result: 2 + 5 equals 7. The verification evidence is on the related card.'
    return 'Thank you.'
  }

  try {
    await openBotChat(host, lead)
    await send(lead, title, 'lifecycle-user-request')
    await until(() => sawGate, 'the provider is about to execute')
    const opened = await find(title)
    assert.ok(opened, 'the card exists while the very first model call is held')
    const first = await cardIn(opened.id, 'running')
    assert.equal(first.owner, lead.id)
    assert.ok(host.model.calls.some(call => JSON.stringify(call.body.messages).includes(first.id)), 'the Bot received the card context')
    const link = host.page.getByRole('button', { name: new RegExp(first.id) }).first()
    await link.waitFor()
    release()
    const waiting = await cardIn(first.id, 'waiting')
    const question = waiting.pending.find(item => item.type === 'question')
    assert.ok(question)
    await channel(host, 'answer-question', { sessionId: question.sessionId, questionId: question.id, answer: { selected: ['Sample A'] } })
    const child = await until(() => find(childTitle), 'the independently assigned child is visible')
    assert.equal(child.parent, first.id)
    const childReview = await cardIn(child.id, 'review')
    assert.equal(childReview.owner, worker.id)
    assert.match(childReview.evidence, /3 \+ 4/)
    const discussion = await channel(host, 'board-comment', {
      id: child.id, op: 'post', body: 'LIFECYCLE_DISCUSSION What did the verification cover?',
      requestId: 'lifecycle-child-comment',
    })
    const reply = await until(async () => {
      const thread = await channel(host, 'board-discussion', { id: child.id, thread: discussion.commentId })
      return thread.entries.find(entry => entry.body === 'The delegated verification checked a second equation.')
    }, 'the Bot answers the triggering comment')
    assert.equal(reply.parentId, discussion.commentId)
    const discussionRuns = await channel(host, 'board-runs', { id: child.id })
    assert.equal(discussionRuns.runs.find(run => run.commentId === discussion.commentId).sessionId, childReview.execution.sessionId)
    assert.equal((await inspect(child.id)).evidenceRevision, childReview.evidenceRevision)
    const submitted = await cardIn(first.id, 'review')
    assert.equal(submitted.attempt, 1)
    const children = (await inspect(first.id)).planning.children
    assert.ok(children.some(item => item.id === child.id))
    await action(submitted, 'reject', 'lifecycle-rework', { text: 'LIFECYCLE_CORRECTION include both checks.' })
    const second = await until(async () => {
      const card = await inspect(first.id)
      return card.lifecycleState === 'review' && card.evidenceRevision === 2 && card
    }, 'rework submits a new evidence version')
    assert.ok(revised)
    assert.equal(second.attempt, 2)
    assert.equal(second.execution.sessionId, first.execution.sessionId)
    await assert.rejects(action({ ...second, evidenceRevision: 1 }, 'approve', 'lifecycle-stale'))
    await action(second, 'approve', 'lifecycle-approved')
    const done = await cardIn(first.id, 'done')
    assert.deepEqual(done.events.filter(item => item.kind === 'report').map(item => item.attempt), [1, 2])
    const stopTitle = 'LIFECYCLE_STOP check one more receipt'
    let finishStopped
    const stoppedGate = new Promise(resolve => { finishStopped = resolve })
    let holding = true
    host.model.reply = async body => {
      if (holding && JSON.stringify(body.messages).includes(stopTitle)) await stoppedGate
      return 'Verified the final sample receipt.'
    }
    try {
      await send(worker, stopTitle, 'lifecycle-stop-request')
      const pending = await until(() => find(stopTitle), 'stoppable work is visible')
      const running = await cardIn(pending.id, 'running')
      const run = await until(async () => (await channel(host, 'board-runs', { id: running.id })).runs.find(item => item.canStop), 'the exact turn can be stopped')
      await action(running, 'run-stop', 'lifecycle-stop', { runId: run.id, turnId: run.turnId })
      const stopped = await cardIn(running.id, 'blocked')
      assert.equal(stopped.failure.kind, 'stopped')
      holding = false
      finishStopped()
      await action(stopped, 'retry', 'lifecycle-retry')
      const retried = await cardIn(stopped.id, 'review')
      assert.equal(retried.attempt, 2)
      assert.equal(retried.execution.sessionId, running.execution.sessionId)
      assert.equal(retried.evidenceRevision, 1)
    } finally { finishStopped() }
    await host.restart()
    const after = await inspect(first.id)
    assert.equal(after.lifecycleState, 'done')
    assert.equal(after.evidenceRevision, 2)
    note('work-board-lifecycle', { parent: first.id, child: child.id, attempt: after.attempt, evidenceRevision: after.evidenceRevision })
  } finally { release() }
}
