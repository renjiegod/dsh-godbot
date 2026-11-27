import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/host/store.js'
import { BotTaskWorkspace, botWorkspaceId as teamId } from '../../src/host/bot-task-workspace.js'
import { WorkBoard, readBoardOnly } from '../../src/host/work-board.js'
import { FullTeamRuns } from '../../src/host/full-team-runs.js'
const tick = () => new Promise((resolve) => setImmediate(resolve))
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'work-board-')),
    database = new Store(dir)
  const rt = {
    state: {
      bots: { b: { id: 'b', name: 'Worker' }, c: { id: 'c', name: 'Other' } },
      rooms: { r: { id: 'r', name: 'Group', members: ['b'], tasks: {} } },
      questions: {},
    },
    live: new Map(),
    readOnly: () => false,
    botOf: (id) => rt.state.bots[id],
    chatOf: (id) => 'session-' + id,
    workOf: (info) => info?.exchangeId,
    openWork() {},
    deliver: async () => {},
    newBotConversation: async () => 'dedicated-b',
    openBotConversation: async (_b, id) => id,
    onSaved: () => () => {},
    feedTap: () => () => {},
    save: async () => {},
  }
  const botTasks = new BotTaskWorkspace(database, rt),
    service = { database, store: botTasks.store, runtime: rt, botTasks }
  service.automation = { full: new FullTeamRuns(service) }
  service.automation.full.rt = rt
  const board = new WorkBoard(service)
  t.after(() => {
    board.close()
    botTasks.dispose()
    database.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, rt, board, database, botTasks }
}
test('a message creates one stable draft, a dispatch is atomic, and only new evidence can be accepted', async (t) => {
  const { board, rt, botTasks, database, dir } = setup(t)
  const origin = { roomId: 'r', sessionId: 'r', messageId: '21' }
  const draft = await board.action({ op: 'create', title: 'Compare results', origin, requestId: 'first' })
  assert.equal(draft.phase, 'todo')
  assert.equal(draft.actions.includes('dispatch'), true)
  const duplicate = await board.action({
    op: 'create',
    title: 'A different title',
    origin,
    requestId: 'other-create',
  })
  assert.equal(draft.id, duplicate.id)
  assert.equal(database.all('tasks').length, 0)
  const dispatch = {
    op: 'dispatch',
    id: draft.id,
    owner: 'b',
    criteria: 'show both receipts',
    version: draft.version,
    requestId: 'dispatch',
  }
  const both = await Promise.all([board.action(dispatch), board.action(dispatch)])
  assert.equal(both[0].id, both[1].id)
  assert.equal(database.all('tasks').length, 1)
  await assert.rejects(board.action({ ...dispatch, requestId: 'double' }), /更新/)
  await tick()
  const native = database.all('tasks')[0]
  assert.equal(database.get('botTaskDeliveries', native.assignmentId).sessionId, 'dedicated-b')
  rt.live.set('dedicated-b', { info: { exchangeId: native.assignmentId }, turn: 2 })
  botTasks.progress({ botId: 'b', sessionId: 'dedicated-b', text: 'Waiting for input', blocked: true })
  assert.equal((await board.item({ id: draft.id })).phase, 'attention')
  assert.throws(() => botTasks.progress({ botId: 'c', sessionId: 'dedicated-b', text: 'wrong' }))
  botTasks.botReply(native.assignmentId, 'v1')
  const prev = await board.item({ id: draft.id })
  await board.action({
    op: 'reject',
    id: draft.id,
    version: prev.version,
    evidenceRevision: 1,
    text: 'show another check',
    requestId: 'reject',
  })
  await tick()
  const now = database.get('tasks', native.id)
  botTasks.botReply(native.assignmentId, 'old result')
  botTasks.botReply(now.assignmentId, 'v2')
  const next = await board.item({ id: draft.id })
  assert.equal(next.evidenceRevision, 2)
  assert.equal(next.execution.sessionId, 'dedicated-b')
  await assert.rejects(
    board.action({ op: 'approve', id: draft.id, version: prev.version, evidenceRevision: 1, requestId: 'stale' }),
    /更新/,
  )
  await board.action({ op: 'approve', id: draft.id, version: next.version, evidenceRevision: 2, requestId: 'ok' })
  assert.equal((await board.item({ id: draft.id })).mark, 'accepted')
  assert.equal(readBoardOnly(dir, rt, 'board-item', { id: draft.id }).actions.length, 0)
  rt.state.bots.b.private = true
  assert.equal((await board.view({})).counts.all, 0)
  await assert.rejects(async () => board.item({ id: draft.id }), /无法访问/)
})
test('historical sources keep independent IDs, closure semantics, run descendants and filtered cursors', async (t) => {
  const { board, rt, database } = setup(t)
  const room = rt.state.rooms.r
  for (const [id, status] of [
    ['one', 'done'],
    ['two', 'cancelled'],
    ['three', 'active'],
  ])
    room.tasks[id] = { id, botId: 'b', goal: 'Group ' + id, status, updatedAt: 500 }
  const write = (id, status, extra = {}) =>
    database.put('tasks', {
      id,
      teamId,
      ownerId: 'b',
      title: id,
      status,
      revision: 2,
      createdAt: '2026-01-01',
      ...extra,
    })
  write('one', 'completed')
  write('two', 'skipped', { workflowNodeId: 'right' })
  database.put('automationRuns', {
    id: 'run',
    teamId,
    targetId: 'room/r',
    rootTaskId: 'root',
    attempt: 1,
    title: 'Team automation',
  })
  for (const [id, status] of [
    ['root', 'completed'],
    ['child', 'reported'],
  ])
    database.put('fullTeamTasks', {
      id,
      teamId,
      runId: 'run',
      targetId: 'bot/b',
      status,
      attempt: 1,
      evidenceRevision: 1,
    })
  const base = await board.view({ limit: 1 })
  assert.equal(base.counts.all, 4)
  assert.equal(base.counts.history, 2)
  const finished = base.columns.find((c) => c.phase === 'done')
  assert.equal(finished.total, 2)
  const other = await board.view({ phase: 'done', limit: 1, after: { done: finished.next } })
  assert.notEqual(other.columns[0].items[0].id, finished.items[0].id)
  assert.deepEqual(
    new Set([other.columns[0].items[0].mark, finished.items[0].mark]),
    new Set(['accepted', 'selfDone']),
  )
  const run = base.columns.find((c) => c.phase === 'review').items[0]
  assert.equal((await board.item({ id: run.id })).children.length, 2)
  rt.state.rooms.r.private = true
  assert.equal((await board.view({})).counts.all, 1)
  assert.equal((await board.view({ room: 'r', search: 'Group' })).counts.all, 0)
})

test('group note retries never notify twice and a partial delivery is visible for reconciliation', async (t) => {
  const { board, rt } = setup(t)
  const task = {
    id: 'note',
    botId: 'b',
    goal: 'Group follow up',
    status: 'active',
    startedAt: 400,
    updatedAt: 400,
    notes: [],
  }
  rt.state.rooms.r.tasks.note = task
  rt.taskNote = (_room, _id, text) => {
    task.notes.push({ text, at: ++task.updatedAt })
    rt.state.rooms.r.workBoardTasksRevision = (rt.state.rooms.r.workBoardTasksRevision ?? 0) + 1
    return { task }
  }
  let sends = 0
  rt.sendUser = async () => {
    sends++
  }
  const card = (await board.view({})).columns.find((c) => c.phase === 'doing').items[0]
  const input = { op: 'note', id: card.id, version: card.version, requestId: 'note-one', text: 'Please follow up' }
  const receipt = await board.action(input)
  assert.equal((await board.action(input)).events.length, 1)
  assert.equal(sends, 1)
  rt.sendUser = async () => {
    sends++
    throw new Error('connection closed after sending')
  }
  const unknown = { ...input, requestId: 'note-two', version: receipt.version, text: 'Second update' }
  await assert.rejects(board.action(unknown), /connection/)
  await assert.rejects(board.action(unknown), /待核对/)
  assert.equal(sends, 2)
  assert.equal((await board.item({ id: card.id })).events.at(-1).kind, 'note-delivery-unconfirmed')
  rt.readOnly = () => true
  await assert.rejects(board.action({ ...unknown, requestId: 'read-only' }), /只读/)
})

test('one full-team root needs every current child accepted and denied targets disappear from counts', async (t) => {
  const { board, rt, database } = setup(t)
  database.put('automationRuns', {
    id: 'run',
    teamId,
    targetId: 'room/r',
    rootTaskId: 'root',
    attempt: 1,
    title: 'Check both receipts',
  })
  for (const [id, targetId] of [
    ['root', 'room/r'],
    ['child', 'bot/b'],
  ]) {
    database.put('fullTeamTasks', {
      id,
      targetId,
      runId: 'run',
      teamId,
      attempt: 1,
      status: 'reported',
      evidenceRevision: 1,
    })
    database.put('fullTeamEvidence', {
      id: 'proof-' + id,
      runId: 'run',
      taskId: id,
      attempt: 1,
      kind: 'report',
      revision: 1,
      evidence: 'fixture proof',
    })
  }
  let card = (await board.view({})).columns.find((c) => c.phase === 'review').items[0]
  for (const childId of ['child', 'root']) {
    const input = {
      op: 'approve',
      id: card.id,
      childId,
      version: card.version,
      evidenceRevision: 1,
      text: 'reviewed',
      requestId: 'review-' + childId,
    }
    card = await board.action(input)
    assert.equal((await board.action(input)).phase, childId === 'root' ? 'done' : 'review')
  }
  rt.state.bots.b.private = true
  assert.equal((await board.view({ search: 'receipts' })).counts.all, 0)
  await assert.rejects(board.item({ id: card.id }), /无法访问/)
})
