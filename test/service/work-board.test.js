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
  board.db.prepare("UPDATE board_requests SET outcome=NULL WHERE id=?").run(input.requestId)
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

test('discussion stores replies, reactions, attachments and wake receipts by card and parent', async (t) => {
  const { board, rt, dir } = setup(t)
  const received = []
  rt.deliver = async (args) => received.push(args)
  rt.ctx = { get: () => ({ saveFile: async ({ name, data }) => ({ name, size: data.length }) }) }
  rt.newBotConversation = async bot => 'discussion-' + bot.id
  const card = await board.action({ op: 'create', title: 'Discussion round trip', requestId: 'discuss' })
  const duplicateCard = await board.action({ op: 'create', title: 'Another card', requestId: 'other' })
  const comment = (req) => board.discussion.action({ id: card.id, ...req })
  const read = (req = {}) => board.discussion.read('board-discussion', { id: card.id, ...req })
  const input = {
    op: 'post', body: '@Worker review @Worker again', targets: ['b'], requestId: 'comment-1',
    files: [{ name: 'proof.txt', mime: 'text/plain', data: 'cHJvb2Y=' }],
  }
  const [posted, retry] = await Promise.all([comment(input), comment(input)])
  assert.deepEqual(posted, retry)
  await tick()
  assert.equal(received.length, 1)
  const out = received[0]
  assert.equal(out.sessionId, 'discussion-b')
  assert.deepEqual(out.files, [{ name: 'proof.txt', size: 5 }])
  assert.match(out.text, /Discussion round trip/)
  assert.match(out.text, /@Worker review/)
  let entry = (await read()).entries[0]
  const attachment = entry.attachments[0]
  assert.equal(entry.runs[0].state, 'sent')
  assert.deepEqual(entry.mentions, ['b'])
  assert.equal((await board.discussion.read('board-comment-file', {
    id: card.id, commentId: entry.id, fileId: attachment.id,
  })).bytes, input.files[0].data)
  await assert.rejects(board.discussion.read('board-comment-file', {
    id: duplicateCard.id, commentId: entry.id, fileId: attachment.id,
  }), /无法访问/)
  await assert.rejects(board.discussion.action({
    id: duplicateCard.id, op: 'post', parentId: entry.id, body: 'Cross-card reply', requestId: 'cross',
  }), /无法访问/)
  await comment({ op: 'resolve', commentId: entry.id, resolved: true, requestId: 'resolve' })
  board.discussion.recordTurn(out.exchangeId, 'unrelated-session', 41, 'running')
  assert.equal((await read()).entries[0].runs[0].turnId, null)
  board.discussion.recordTurn(out.exchangeId, out.sessionId, 7, 'running')
  board.discussion.reply(out.exchangeId, 'Actual Bot answer')
  board.discussion.reply(out.exchangeId, 'Duplicate runtime receipt')
  const thread = await read({ thread: entry.id })
  assert.equal(thread.root.resolvedAt, null)
  assert.equal(thread.root.replyCount, 1)
  assert.equal(thread.root.runs[0].state, 'answered')
  assert.equal(thread.root.runs[0].turnId, 7)
  assert.equal(thread.entries[0].body, 'Actual Bot answer')
  const answer = thread.entries[0]
  await comment({ op: 'react', commentId: answer.id, emoji: '👍', active: true, requestId: 'reaction' })
  await comment({ op: 'post', parentId: answer.id, body: 'And what next?', requestId: 'follow-up', targets: ['b'] })
  await tick()
  assert.equal(received.length, 2)
  assert.equal(received[1].sessionId, out.sessionId)
  assert.match(received[1].text, /Actual Bot answer/)
  await comment({
    op: 'edit', commentId: entry.id, body: '@Worker and @Other', expectedRevision: 1,
    keepFiles: [attachment.id], targets: ['c'], requestId: 'edit',
  })
  await tick()
  assert.equal(received.length, 3)
  assert.equal(received[2].toId, 'c')
  await assert.rejects(comment({ op: 'delete', commentId: entry.id, expectedRevision: 1, requestId: 'old' }), /已更新/)
  await comment({ op: 'delete', commentId: entry.id, expectedRevision: 2, requestId: 'delete' })
  entry = (await read()).entries[0]
  assert.equal(entry.deleted, true)
  assert.equal(entry.body, '')
  assert.deepEqual(entry.attachments, [])
  const saved = readBoardOnly(dir, rt, 'board-discussion', { id: card.id, thread: entry.id, focus: answer.id })
  assert.equal(saved.readOnly, true)
  assert.equal(saved.focusFound, true)
  assert.deepEqual(saved.entries[0].reactions, ['👍'])
  rt.state.bots.b.private = true
  assert.equal((await read({ thread: entry.id })).entries[0].body, '')
  await assert.rejects(comment({ op: 'post', body: 'unsafe', targets: ['b'], requestId: 'stale-plan' }), /已更新/)
})

test('discussion never invokes outside the source group and separates notes from dispatch', async (t) => {
  const { board, rt, database } = setup(t)
  const delivered = []
  rt.deliver = async args => delivered.push(args)
  const card = await board.action({ op: 'create', title: 'Group context', owner: 'b', room: 'r', requestId: 'group-draft' })
  const write = (body, requestId, extra) => board.discussion.action({ id: card.id, body, op: 'post', requestId, ...extra })
  await write('Ordinary comment', 'ordinary')
  await write('@Other should not see group notes', 'outside')
  await write('@Worker only a note', 'quiet', { quiet: true })
  await tick()
  assert.equal(delivered.length, 0)
  const page = await board.discussion.read('board-discussion', { id: card.id })
  assert.equal(page.entries.length, 3)
  assert.equal(page.entries[1].unmatched, true)
  assert.equal(page.assignee, null)
  assert.deepEqual(page.bots.map(bot => bot.id), ['b'])
  assert.equal(database.all('tasks').length, 0)
  const cited = await write('@Worker check this', 'call', { targets: ['b'] })
  await tick()
  assert.equal(delivered.length, 1)
  board.discussion.recordTurn(delivered[0].exchangeId, delivered[0].sessionId, 3, 'stopped')
  board.discussion.reply(delivered[0].exchangeId, 'Stopped text must not become a successful reply')
  const latest = await board.discussion.read('board-discussion', { id: card.id, thread: cited.commentId })
  assert.equal(latest.root.runs[0].state, 'stopped')
  assert.equal(latest.entries.length, 0)
})

test('manual tasks accept catalog fields, preserve edits, reopen and support scoped bulk changes and saved views', async t => {
  const { board } = setup(t)
  const command = (op, payload, requestId) => board.action({ op, requestId, ...payload })
  const status = await command('configure', { entry: { kind: 'status', name: 'Ready', phase: 'todo' } }, 'status')
  const effort = await command('configure', { entry: { kind: 'property', name: 'Effort', propertyType: 'number' } }, 'property')
  const task = await command('create', {
    title: 'Release notes', description: 'Findable description', statusId: status.id,
    assignee: 'person/owner', labels: ['Release'], startDate: '2026-11-28', dueDate: '2026-12-01',
    customValues: { [effort.id]: 4 },
  }, 'notes')
  assert.equal(task.fields.assignee, 'person/owner')
  assert.equal(task.statusId, status.id)
  assert.equal(task.fields.customValues[effort.id], 4)
  assert.equal((await board.view({ search: 'findable DESCRIPTION' })).counts.all, 1)
  assert.equal((await board.view({ label: 'Release', property: effort.id, propertyValue: '4' })).counts.all, 1)
  const complete = await command('complete', { id: task.id, version: task.version }, 'complete')
  assert.equal(complete.phase, 'done')
  const current = await command('reopen', { id: complete.id, version: complete.version }, 'reopen')
  assert.equal(current.phase, 'todo')
  assert.equal(current.planning.audit.length, 2)
  await assert.rejects(command('edit-fields', {
    id: task.id, version: current.version, dueDate: '2026-02-30',
  }, 'bad-date'), /有效日期/)
  const saved = await command('configure', { entry: {
    kind: 'view', name: 'Releases', visibility: 'shared',
    filters: { label: 'Release', sort: 'dueDate', injected: true }, display: { layout: 'gantt', groupBy: 'assignee' },
  } }, 'view')
  assert.deepEqual(saved.filters, { label: 'Release', sort: 'dueDate' })
  assert.deepEqual((await board.view({})).catalog.views.find(view => view.id === saved.id).display, { layout: 'gantt', groupBy: 'assignee' })
  const bulk = {
    items: [{ id: task.id, version: current.version }, { id: 'GB-7777', version: 'old' }],
    patch: { addLabels: ['Verified'], priority: 2, dueDate: '2026-12-03' },
  }
  const result = await command('bulk', bulk, 'batch')
  assert.deepEqual(result.applied, [task.id])
  assert.equal(result.rejected[0].id, 'GB-7777')
  assert.deepEqual(await command('bulk', bulk, 'batch'), result)
  assert.deepEqual((await board.item({ id: task.id })).fields.labels, ['Release', 'Verified'])
})

test('the unassigned label and the unassigned assignee are independent board filters', async t => {
  const { board } = setup(t)
  const labelled = await board.action({
    op: 'create', title: 'Has the unassigned label', assignee: 'person/owner', labels: ['unassigned'], requestId: 'labelled',
  })
  const unassigned = await board.action({ op: 'create', title: 'Has no assignee', requestId: 'unassigned' })
  const labelledView = await board.view({ label: 'unassigned' })
  const unassignedView = await board.view({ assignee: 'unassigned' })
  assert.equal(labelledView.counts.all, 1)
  assert.equal(unassignedView.counts.all, 1)
  assert.deepEqual(labelledView.columns.flatMap(column => column.items.map(item => item.id)), [labelled.id])
  assert.deepEqual(unassignedView.columns.flatMap(column => column.items.map(item => item.id)), [unassigned.id])
})

test('parent and dependency edits reject cycles and dispatch a later stage once the prerequisites end', async t => {
  const { board, database } = setup(t)
  let n = 0
  const act = (op, inputs, item) => board.action({
    op, id: item?.id, version: item?.version, requestId: 'relations-' + n++, ...inputs,
  })
  const parent = await act('create', { title: 'Ship' })
  const first = await act('create', { title: 'Build', parent: parent.id, stage: 1 })
  const second = await act('create', { title: 'Verify', parent: parent.id, stage: 2 })
  await assert.rejects(act('edit-fields', { blockedBy: [second.id] }, first), /循环/)
  await assert.rejects(act('edit-fields', { parent: second.id }, parent), /循环/)
  const waiting = await act('dispatch', { owner: 'b', criteria: 'Read the build report' }, second)
  assert.equal(waiting.planning.pendingDispatch, true)
  assert.deepEqual(waiting.planning.prerequisites.map(row => row.id), [first.id])
  assert.equal(database.all('tasks').length, 0)
  const archived = await act('archive', {}, first)
  assert.equal((await board.item({ id: second.id })).planning.pendingDispatch, true)
  assert.equal((await board.item({ id: parent.id })).planning.progress.completed, 0)
  assert.equal(database.all('tasks').length, 0)
  await assert.rejects(act('edit-fields', { duplicateOf: second.id }, archived), /循环/)
  const restored = await act('reopen', {}, archived)
  await act('complete', {}, restored)
  const assigned = await board.item({ id: second.id })
  assert.equal(assigned.id, second.id)
  assert.equal(database.all('tasks').length, 1)
  assert.deepEqual((await board.item({ id: parent.id })).planning.progress, { completed: 1, total: 2 })
  const duplicate = await act('create', { title: 'Another copy', duplicateOf: first.id })
  assert.equal(duplicate.mark, 'duplicate')
  assert.equal((await act('reopen', {}, duplicate)).planning.duplicateOf, null)
})

test('changes to requirements invalidate old evidence across both review entry points', async t => {
  const { board, database, botTasks } = setup(t)
  const draft = await board.action({ op: 'create', title: 'Audit', requestId: 'audit-create' })
  await board.action({ op: 'dispatch', id: draft.id, version: draft.version, owner: 'b', criteria: 'Check version one', requestId: 'audit-dispatch' })
  await tick()
  const task = database.all('tasks')[0]
  botTasks.botReply(task.assignmentId, 'Old proof')
  const before = await board.item({ id: draft.id })
  const edited = await board.action({
    op: 'edit-fields', id: draft.id, version: before.version, title: 'Audit revised', criteria: 'Check version two',
    description: 'Updated source', reason: 'New scope', requestId: 'audit-edit',
  })
  assert.equal(edited.reviewBlocked, true)
  assert.equal(edited.evidence, 'Old proof')
  assert.equal(edited.actions.includes('approve'), false)
  assert.equal(edited.planning.audit[0].reason, 'New scope')
  assert.throws(() => botTasks.apply({ action: 'task.review', teamId, taskId: task.id, approve: true }), /验收条件已更新/)
  await board.action({
    op: 'reject', id: draft.id, version: edited.version, evidenceRevision: edited.evidenceRevision,
    text: 'Use the revised criteria', requestId: 'audit-reject',
  })
  await tick()
  const revised = database.get('tasks', task.id)
  assert.match(database.get('messages', revised.assignmentId).text, /Check version two/)
  botTasks.botReply(revised.assignmentId, 'New proof')
  const current = await board.item({ id: draft.id })
  assert.equal(current.actions.includes('approve'), true)
  const archived = await board.runs.query({ id: draft.id })
  assert.equal(archived.runs.length, 2)
})

test('an unsent assignment uses the latest work board requirements when it leaves the queue', async t => {
  const { board, rt, database, botTasks } = setup(t)
  const deliveries = []
  rt.deliver = async message => { deliveries.push(message) }
  const dispatch = async (title, key) => {
    const card = await board.action({ op: 'create', title, requestId: key + '-create' })
    return board.action({
      op: 'dispatch', id: card.id, version: card.version, owner: 'b', criteria: 'Check version one', requestId: key + '-dispatch',
    })
  }
  await dispatch('First assignment', 'first')
  await tick()
  const card = await dispatch('Second assignment', 'second')
  await tick()
  const task = database.all('tasks').find(task => task.title === 'Second assignment')
  assert.equal(database.get('botTaskDeliveries', task.assignmentId).state, 'queued')
  assert.equal(deliveries.length, 1)

  await board.action({
    op: 'edit-fields', id: card.id, version: card.version, title: 'Updated assignment', criteria: 'Check version two',
    description: 'Read the new source', reason: 'Correct the scope before it starts', requestId: 'second-edit',
  })
  botTasks.botReply(deliveries[0].exchangeId, 'First assignment result')
  await tick()
  assert.equal(deliveries.length, 2)
  const sent = deliveries[1]
  assert.equal(sent.exchangeId, task.assignmentId)
  assert.match(sent.text, /Updated assignment/)
  assert.match(sent.text, /Acceptance criteria: Check version two/)
  assert.match(sent.text, /Read the new source/)
  assert.doesNotMatch(sent.text, /Check version one/)

  botTasks.botReply(sent.exchangeId, 'Proof for the current requirements')
  const detail = await board.item({ id: card.id })
  assert.equal(detail.actions.includes('approve'), true)
  assert.equal(detail.planning.audit[0].reason, 'Correct the scope before it starts')
})

test('annotations, conclusions, attachment versions and comment snapshots remain tied to their source', async t => {
  const { board } = setup(t)
  const card = await board.action({ op: 'create', title: 'Discuss', description: 'First paragraph', requestId: 'discuss' })
  const file = { name: 'proof.txt', mime: 'text/plain' }
  const post = (body, requestId, extra = {}) => board.discussion.action({ id: card.id, op: 'post', body, quiet: true, requestId, ...extra })
  const first = await post('Original proof', 'post-first', { files: [{ ...file, data: Buffer.from('first').toString('base64') }] })
  const second = await post('Revised proof', 'post-next', {
    parentId: first.commentId, files: [{ ...file, data: Buffer.from('second').toString('base64') }],
    annotations: [{ commentId: first.commentId, start: 0, end: 8, quote: 'Original', note: 'Keep this earlier proof' }],
  })
  await board.discussion.action({
    id: card.id, op: 'resolve', commentId: first.commentId, conclusionId: second.commentId, resolved: true, requestId: 'conclude',
  })
  const root = (await board.discussion.read('board-discussion', { id: card.id })).entries[0]
  assert.equal(root.conclusion.id, second.commentId)
  const artifacts = await board.discussion.read('board-artifacts', { id: card.id })
  assert.deepEqual(artifacts.artifacts[0].versions.map(v => v.version), [1, 2])
  assert.equal((await board.view({ search: 'revised proof' })).counts.all, 1)
  const child = await board.action({ op: 'create', title: 'Follow up', parent: card.id, commentId: second.commentId, requestId: 'child' })
  assert.equal(child.planning.snapshot.context.comments[1].text, 'Revised proof')
  const snapshotFile = child.planning.snapshot.attachments[1].id
  await board.discussion.action({
    id: card.id, op: 'edit', commentId: first.commentId, body: 'Original proof', expectedRevision: 1,
    requestId: 'new-file-version', files: [{ ...file, data: Buffer.from('third').toString('base64') }],
  })
  const afterEdit = (await board.discussion.read('board-artifacts', { id: card.id })).artifacts[0].versions
  assert.deepEqual(afterEdit.map(v => v.commentId), [first.commentId, second.commentId, first.commentId])
  assert.deepEqual(afterEdit.map(v => v.version), [1, 2, 3])
  await board.discussion.action({
    id: card.id, op: 'delete', commentId: second.commentId, expectedRevision: 1, requestId: 'delete',
  })
  const afterDelete = (await board.discussion.read('board-artifacts', { id: card.id })).artifacts[0].versions
  assert.deepEqual(afterDelete.map(v => v.version), [1, 3])
  const downloaded = await board.discussion.read('board-comment-file', { id: child.id, fileId: snapshotFile, snapshot: true })
  assert.equal(Buffer.from(downloaded.bytes, 'base64').toString(), 'second')
  await post('More information', 'post-more', { parentId: first.commentId })
  assert.equal((await board.discussion.read('board-discussion', { id: card.id })).entries[0].conclusion, null)
})
