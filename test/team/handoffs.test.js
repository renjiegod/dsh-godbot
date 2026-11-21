import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/host/store.js'
import { TeamActions } from '../fixtures/member-team.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-handoff-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  store.put('teams', { id: 'room', name: 'room', leadId: 'lead' })
  const ids = ['lead', 'writer', 'reviewer']
  const [lead, writer, reviewer] = ids.map((id) => store.put('members', { id, name: id, teamId: 'room' }))
  const stops = []
  const actions = new TeamActions(
    store,
    (input) => store.put('commands', { ...input, id: 'c' + store.all('commands').length, status: 'queued' }),
    (...args) => stops.push(args),
  )
  const create = (actor = lead, ownerId = 'writer', dependsOn = []) =>
    actions.assign({ teamId: 'room', ownerId, title: 'task', criteria: 'evidence', dependsOn }, actor)
  const get = (id) => store.require('tasks', id)
  const work = (task) => {
    const turn = store.put('turns', {
      id: 't' + task.assignmentId,
      memberId: task.ownerId,
      taskId: task.id,
      messageId: task.assignmentId,
    })
    store.update('members', task.ownerId, { activeTurnId: turn.id })
    actions.turnStarted(turn)
    return turn
  }
  return { store, actions, lead, writer, reviewer, stops, create, get, work }
}

test('report replies to the original assignment once and acknowledgements never wake the worker', (t) => {
  const { store, actions, lead, writer, create, work } = fixture(t)
  const task = create()
  const assigned = store.require('messages', task.assignmentId)
  const turn = work(task)
  const report = actions.report({ taskId: task.id, evidence: 'tested SHA' }, writer)
  const msg = store.require('messages', report.reportMessageId)
  assert.deepEqual(
    [msg.kind, msg.replyTo, msg.exchangeId, msg.taskId, msg.to],
    ['report', assigned.id, assigned.exchangeId, task.id, [lead.id]],
  )
  assert.equal(store.all('commands').length, 2)
  assert.equal(actions.report({ taskId: task.id, evidence: 'tested SHA' }, writer).reportMessageId, msg.id)
  actions.turnEnded({ member: writer, turn, status: 'completed', answer: 'closing chatter' })
  const reviewTurn = { id: 'r', memberId: lead.id, taskId: task.id, messageId: msg.id }
  actions.turnStarted(reviewTurn)
  actions.turnEnded({ member: lead, turn: reviewTurn, status: 'completed', answer: 'I received this result' })
  const ack = store.all('messages').at(-1)
  assert.deepEqual(
    [ack.kind, ack.replyTo, ack.exchangeId, ack.taskId, ack.to],
    ['ack', msg.id, assigned.exchangeId, task.id, [writer.id]],
  )
  assert.equal(store.all('commands').length, 2)
  assert.equal(store.require('tasks', task.id).status, 'reported')
})

test('a human requester gets the report; self-assignments and self-messages do not enqueue their author', (t) => {
  const { actions, store, writer, create } = fixture(t)
  const task = create(null)
  const result = actions.report({ taskId: task.id, evidence: 'proof' }, writer)
  assert.deepEqual(store.require('messages', result.reportMessageId).to, ['user'])
  assert.equal(store.all('commands').length, 1)
  const self = create(writer, writer.id)
  const selfReport = actions.report({ taskId: self.id, evidence: 'proof' }, writer)
  assert.equal(selfReport.status, 'reported')
  actions.send({ teamId: 'room', to: [writer.id], text: 'note' }, writer)
  assert.equal(store.all('commands').length, 1)
})

test('members broadcast to peers and only a successful direct answer wakes an original sender', (t) => {
  const { actions, store, writer, lead } = fixture(t)
  actions.send({ teamId: 'room', text: '@all check' }, writer)
  assert.deepEqual(
    store.all('commands').map((c) => c.memberId),
    ['lead', 'reviewer'],
  )
  const msg = actions.send({ teamId: 'room', to: [writer.id], text: 'please check' }, lead)
  const turn = { id: 'failed', memberId: writer.id, messageId: msg.id }
  const count = store.all('commands').length
  actions.turnEnded({ member: writer, turn, status: 'failed', answer: 'partial' })
  assert.equal(store.all('messages').at(-1).status, 'failed')
  assert.equal(store.all('commands').length, count)
  actions.turnEnded({ member: writer, turn: { ...turn, id: 'success' }, status: 'completed', answer: 'yes' })
  const ack = store.all('messages').at(-1)
  assert.deepEqual([ack.kind, ack.replyTo, ack.exchangeId], ['ack', msg.id, msg.exchangeId])
  assert.equal(store.all('commands').length, count + 1)
  actions.turnEnded({
    member: lead,
    turn: { id: 'ack', memberId: lead.id, messageId: ack.id },
    status: 'completed',
    answer: 'thanks',
  })
  assert.equal(store.all('commands').length, count + 1)
})

test('failed dependencies block recursively; retry requires a current revision and downstream waits for acceptance', (t) => {
  const { actions, writer, lead, reviewer, create, work, store, get } = fixture(t)
  const a = create(),
    b = create(lead, reviewer.id, [a.id]),
    c = create(lead, writer.id, [b.id])
  const old = work(a)
  actions.turnEnded({
    member: writer,
    turn: old,
    status: 'failed',
    reason: 'CLI died',
    answer: 'partial output',
  })
  assert.equal(get(a.id).status, 'failed')
  assert.deepEqual(get(b.id).blockedBy, [a.id])
  assert.deepEqual(get(c.id).blockedBy, [b.id])
  assert.throws(() => actions.retry({ taskId: a.id, expectedRevision: 0 }), /revision/)
  const next = actions.retry({
    taskId: a.id,
    expectedRevision: get(a.id).revision,
    expectedOwnerId: writer.id,
  })
  assert.equal(next.attempt, 2)
  assert.equal(get(b.id).status, 'waiting')
  assert.equal(get(c.id).status, 'waiting')
  const stale = () => actions.report({ taskId: a.id, evidence: 'old output' }, writer)
  assert.throws(stale, /assignment changed/)
  actions.turnEnded({ member: writer, turn: old, status: 'failed', reason: 'late duplicate' })
  assert.equal(get(a.id).status, 'assigned')
  const working = work(next)
  actions.turnEnded({ member: writer, turn: working, status: 'completed', answer: 'CLI success only' })
  assert.equal(get(a.id).status, 'awaiting-report')
  const report = actions.report(
    { taskId: a.id, assignmentId: next.assignmentId, evidence: 'new proof' },
    writer,
  )
  const edited = actions.report(
    { taskId: a.id, evidence: 'corrected', expectedEvidenceRevision: report.evidenceRevision },
    writer,
  )
  assert.throws(
    () => actions.review({ taskId: a.id, approve: true, expectedEvidenceRevision: report.evidenceRevision }),
    /evidence changed/,
  )
  actions.review({ taskId: a.id, approve: true, expectedRevision: edited.revision })
  assert.equal(get(b.id).status, 'assigned')
  assert.match(store.require('messages', get(b.id).assignmentId).text, /corrected/)
  assert.equal(get(c.id).status, 'waiting')
})

test('transfer stops a live assignment first, then issues one new attempt and rejects the old owner', (t) => {
  const { actions, stops, writer, reviewer, create, work, store, get } = fixture(t)
  const a = create()
  const live = work(a)
  assert.throws(
    () =>
      actions.transfer({
        taskId: a.id,
        expectedRevision: get(a.id).revision,
        expectedOwnerId: reviewer.id,
        ownerId: reviewer.id,
      }),
    /owner changed/,
  )
  const pending = actions.transfer({
    taskId: a.id,
    expectedRevision: get(a.id).revision,
    ownerId: reviewer.id,
  })
  assert.equal(pending.status, 'transferring')
  assert.equal(pending.ownerId, writer.id)
  assert.deepEqual(stops, [[writer.id, live.id]])
  assert.equal(store.all('commands').length, 1)
  actions.turnEnded({ member: writer, turn: live, status: 'interrupted' })
  const target = get(a.id)
  assert.equal(target.status, 'assigned')
  assert.equal(target.ownerId, reviewer.id)
  assert.equal(target.attempt, 2)
  actions.turnEnded({ member: writer, turn: live, status: 'interrupted' })
  assert.equal(store.all('commands').length, 2)
  assert.throws(() => actions.report({ taskId: a.id, evidence: 'late' }, writer), /assigned member/)
  assert.equal(
    actions.report({ taskId: a.id, assignmentId: target.assignmentId, evidence: 'ok' }, reviewer).status,
    'reported',
  )
})

test('unconfirmed cancellation blocks transfer until explicit recovery', (t) => {
  const { actions, writer, reviewer, create, work, get, store } = fixture(t)
  const a = create(),
    live = work(a)
  actions.transfer({ taskId: a.id, expectedRevision: get(a.id).revision, ownerId: reviewer.id })
  actions.turnEnded({ member: writer, turn: live, status: 'unknown', reason: 'disconnected' })
  assert.equal(get(a.id).ownerId, writer.id)
  assert.equal(get(a.id).status, 'failed')
  assert.equal(get(a.id).failure.kind, 'unknown')
  assert.equal(store.all('commands').length, 1)
})
