import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Store } from '../../src/host/store.js'
import { BotTaskWorkspace, botWorkspaceId } from '../../src/host/bot-task-workspace.js'
import { FullTeamRuns } from '../../src/host/full-team-runs.js'
import { BotBudget, taskBudgetReceipt } from '../../src/host/bot-budget.js'
import { answerSender } from '../../src/host/team-runtime/core/turns.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-real-bot-tasks-'))
  const raw = new Store(dir)
  const calls = [], sessions = [], events = new Map()
  const bots = Object.fromEntries(['worker', 'other', 'private'].map(id => [id, { id, name: 'Bot ' + id, private: id === 'private' }]))
  const rt = {
    state: { bots, mainBotIds: ['worker'], rooms: { room: { id: 'room', name: 'group', members: ['worker','other'] },
      closed: { id: 'closed', members: ['private'] } }, questions: {} },
    botOf: id => bots[id], roomOf: () => undefined, chatOf: id => 'session-' + id, selfOf: id => id.replace('session-', ''),
    readOnly: () => false, openWork: (id, target) => calls.push([id, target]),
    deliver: async req => { assert.ok(req.toId); sessions.push(req) },
    workOf: info => info?.exchangeId, live: new Map(), approvalsView: () => [],
    onSaved: fn => { events.set('save', fn); return () => events.delete('save') },
    holdWork() {}, closeWork() {}, dropWork() {}, abandonWork() {}, postToRoom() {}, settleSubWork() {},
    ledger: { append() {} }, ctx: { effect() {}, on: (name, fn) => { events.set(name, fn); return () => events.delete(name) } },
  }
  const workspace = new BotTaskWorkspace(raw, rt)
  const full = new FullTeamRuns({ store: raw, botTasks: workspace })
  full.attach(rt)
  const work = (id, text) => {
    const req = sessions.find(call => call.exchangeId === id)
    const info = { role: 'request', exchangeId: req.exchangeId }
    rt.live.set(req.sessionId, { info, joined: [], turn: 42 })
    events.get('session/event')({ id: req.sessionId }, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    answerSender(rt, req.sessionId, info, text)
    rt.live.delete(req.sessionId)
  }
  t.after(async () => { workspace.dispose(); full.detach(); raw.close(); await rm(dir, { recursive: true, force: true }) })
  return { workspace, raw, calls, sessions, rt, events, work }
}

test('workspace task, report, review and rework use only the live Bot ID and its own real chat', async t => {
  const { workspace, raw, calls, sessions, work, rt } = await fixture(t)
  assert.deepEqual(raw.all('members'), [])
  assert.deepEqual(raw.all('teams'), [])
  assert.deepEqual(workspace.targets(botWorkspaceId).map(t => t.id), ['bot/worker', 'bot/other', 'room/room'])
  assert.deepEqual(workspace.snapshot().bots.map(b => b.id), ['worker','other'])
  const req = { action: 'task.create', title: 'Inspect', criteria: 'Report a result', ownerId: 'worker', requestId:'once' }
  assert.throws(() => workspace.mutate({ ...req, ownerId: 'private' }), /Unknown members/)
  const task = workspace.mutate(req)
  assert.equal(workspace.mutate(req).id, task.id)
  await flush()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [task.assignmentId, { to:'worker' }])
  assert.deepEqual(sessions.map(s => [s.toId,s.sessionId]), [['worker','session-worker']])
  assert.match(sessions[0].text, /Report a result/)
  assert.doesNotMatch(sessions[0].text, /report_result/)
  work(task.assignmentId, 'Observed result')
  let row = raw.require('tasks', task.id)
  assert.equal(row.ownerId, 'worker')
  assert.equal(row.reportedBy, 'worker')
  assert.equal(row.evidence, 'Observed result')
  assert.equal(row.status, 'reported')
  assert.equal(raw.require('botTaskDeliveries', task.assignmentId).turnId, 42)
  assert.equal(raw.require('messages', row.reportMessageId).replyTo, task.assignmentId)
  assert.equal(sessions.length, 1)
  row = workspace.mutate({action:'task.review',taskId:row.id,approve:false,evidence:'Show the actual result',expectedEvidenceRevision:row.evidenceRevision})
  await flush()
  assert.equal(row.attempt, 2)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[1].sessionId, 'session-worker')
  assert.match(sessions[1].text, /Show the actual result/)
  workspace.botReply(task.assignmentId,'stale first result')
  assert.equal(raw.require('tasks', task.id).status, 'assigned')
  work(row.assignmentId, 'Revised evidence')
  const done = workspace.mutate({action:'task.review',taskId:task.id,approve:true,expectedEvidenceRevision:2})
  assert.equal(done.status, 'completed')
  assert.deepEqual(raw.all('commands'), [])
  delete rt.state.bots.worker
  assert.equal(workspace.store.get('members','worker'), undefined)
  assert.deepEqual(workspace.snapshot().bots.map(b=>b.id), ['other'])
})

test('parallel assignments to a Bot serialize and a workflow releases its next real Bot only after acceptance', async t => {
  const { workspace, raw, sessions, work } = await fixture(t)
  const define = workspace.mutate({ action:'workflow.save', name:'Audit', nodes:[
    {id:'first',title:'Discover',criteria:'Evidence',ownerId:'worker'},
    {id:'second',title:'Inspect',criteria:'Conclusion',ownerId:'other'},
  ], edges:[{from:'first',to:'second',when:'contains',value:'OK'}] })
  const run = workspace.mutate({ action:'workflow.run', id:define.id,expectedRevision:1,requestId:'work1' })
  const second = workspace.mutate({ action:'task.create',title:'Parallel',criteria:'Done',ownerId:'worker' })
  await flush()
  assert.equal(sessions.length, 1)
  const root = raw.require('tasks',run.nodes[0].taskId)
  work(root.assignmentId,'OK first')
  await flush()
  assert.deepEqual(sessions.map(s=>s.exchangeId), [root.assignmentId,second.assignmentId])
  assert.equal(workspace.workflows().runs[0].status, 'needs-review')
  workspace.mutate({action:'task.review',taskId:root.id,approve:true,expectedEvidenceRevision:1})
  await flush()
  assert.equal(sessions.length, 3)
  assert.equal(sessions[2].sessionId,'session-other')
  assert.match(sessions[2].text,/OK first/)
  work(sessions[2].exchangeId,'Accepted proof')
  workspace.mutate({action:'task.review',taskId:run.nodes[1].taskId,approve:true,expectedEvidenceRevision:1})
  assert.equal(workspace.workflows().runs[0].status,'completed')
  assert.equal(raw.require('tasks', second.id).status, 'assigned')
})

test('a failed or merged Bot turn, and a host restart in the delivery window, cannot produce accepted evidence or duplicate delivery', async t => {
  const { workspace, raw, sessions, rt } = await fixture(t)
  const create = name => workspace.mutate({action:'task.create',title:name,criteria:'specific',ownerId:'worker'})
  const a = create('A')
  await flush()
  workspace.observeEnd('session-worker',{info:{exchangeId:a.assignmentId},joined:[{info:{exchangeId:'unrelated'}}]}, {kind:'stop'})
  workspace.botReply(a.assignmentId,'mixed reply')
  assert.equal(raw.require('tasks',a.id).failure.kind, 'unknown')
  const b = create('B')
  await flush()
  workspace.observeEnd('session-worker',{info:{exchangeId:b.assignmentId}}, {kind:'error'})
  assert.equal(raw.require('tasks',b.id).failure.kind,'failed')
  const c = create('C')
  await flush()
  workspace.dispose()
  const restarted = new BotTaskWorkspace(raw,rt)
  t.after(()=>restarted.dispose())
  await flush()
  assert.equal(raw.require('tasks',c.id).failure.kind,'unknown')
  assert.equal(sessions.filter(row=>row.exchangeId===c.assignmentId).length,1)
  const retried = restarted.mutate({action:'task.retry',taskId:c.id,expectedRevision:raw.require('tasks',c.id).revision})
  await flush()
  assert.notEqual(retried.assignmentId,c.assignmentId)
  assert.equal(sessions.at(-1).exchangeId,retried.assignmentId)
})

test('owner access changes revoke pending work and keep private results off the task board', async t => {
  const { workspace, raw, sessions, rt, events } = await fixture(t)
  const create = title => workspace.mutate({action:'task.create', title, criteria:'proof',ownerId:'worker'})
  const running = create('test active')
  const queued = create('test queued')
  await flush()
  rt.state.bots.worker.private = true
  events.get('save')()
  await flush()
  assert.equal(raw.require('tasks', running.id).failure.kind, 'unknown')
  assert.equal(raw.require('tasks', queued.id).failure.kind, 'failed')
  workspace.botReply(running.assignmentId, 'private-after-change')
  assert.ok(!JSON.stringify(workspace.snapshot()).includes('private-after-change'))
  assert.equal(sessions.length, 1)
  rt.state.bots.worker.private = false
  const readOnly = create('becomes read only')
  await flush()
  rt.readOnly = () => true
  workspace.botReply(readOnly.assignmentId, 'late')
  assert.equal(raw.require('tasks', readOnly.id).status, 'assigned')
  assert.throws(() => create('denied'), /只读/)
  rt.readOnly = () => false
  workspace.resume()
  assert.equal(raw.require('tasks', readOnly.id).failure.kind, 'unknown')
})

test('pending approval and questions are scoped to their actual Bot turn and visible to workflow status', async t => {
  const { workspace, raw, rt, work } = await fixture(t)
  const wf = workspace.mutate({action:'workflow.save',name:'Check',
    nodes:[{id:'one',title:'Check',criteria:'answer',ownerId:'worker'}],edges:[]})
  const run = workspace.mutate({action:'workflow.run',id:wf.id,expectedRevision:1,requestId:'pending-flow'})
  await flush()
  const task = raw.require('tasks',run.nodes[0].taskId)
  rt.live.set('session-worker',{info:{exchangeId:task.assignmentId}})
  rt.approvalsView = () => [{sessionId:'session-worker',id:'permit'}, {sessionId:'session-other',id:'unrelated'}]
  assert.deepEqual(workspace.workflows().runs[0].pending.map(item=>item.id), ['permit'])
  rt.approvalsView = () => []
  rt.state.questions['session-worker'] = {id:'question'}
  work(task.assignmentId,'evidence')
  assert.deepEqual(workspace.workflows().runs[0].pending.map(item=>item.id), ['question'])
  assert.throws(() => workspace.mutate({action:'task.review',taskId:task.id,approve:true,expectedEvidenceRevision:1}), /问题或审批/)
  rt.state.questions['session-worker'] = {id:'different-question'}
  workspace.mutate({action:'task.review',taskId:task.id,approve:true,expectedEvidenceRevision:1})
  assert.equal(workspace.workflows().runs[0].status,'completed')
})

test('a Bot-budget hold survives a restart and its eventual real reply is the sole assignment receipt', async t => {
  const { workspace, raw, sessions, rt } = await fixture(t)
  const wf = workspace.mutate({action:'workflow.save',name:'Queue under budget',
    nodes:[{id:'one',title:'Bounded',criteria:'actual reply',ownerId:'worker'}],edges:[]})
  const run = workspace.mutate({action:'workflow.run',id:wf.id,expectedRevision:1,requestId:'limited'})
  await flush()
  const task = raw.require('tasks',run.nodes[0].taskId)
  const id = task.assignmentId
  rt.isBotSession = sessionId => sessionId === 'session-worker'
  const policy = { store:workspace.store, clock:Date.now,
    service:{runtime:rt}, refusal:() => ({limit:'dailyTokens',resetsAt:Date.now()+60_000}) }
  const budget = new BotBudget(policy, { on() {} })
  budget.close()
  const msg = { id:'real-message',source:{kind:'bot',role:'request',exchangeId:id},content:[] }
  const agent = { id:'session-worker',inbox:{nextTurn:[],nextStep:[]},followup(message){this.replay=message} }
  const decision = await budget.preStep({ agent, step:1, messages:[msg] }, () => assert.fail('admitted over budget'))
  assert.deepEqual(decision, {kind:'reject'})
  workspace.observeEnd('session-worker',{info:msg.source},{kind:'aborted'})
  workspace.botReply(id,'')
  assert.equal(raw.require('tasks',task.id).status,'assigned')
  assert.match(workspace.workflows().runs[0].reason,/dailyTokens/)
  workspace.dispose()
  const resumed = new BotTaskWorkspace(raw,rt)
  t.after(()=>resumed.dispose())
  assert.equal(raw.require('tasks',task.id).status,'assigned')
  policy.refusal = () => null
  rt.resolveAgent = async () => agent
  rt.ctx.sessions = {flush:async () => true}
  const restored = new BotBudget(policy, { on() {} })
  try { await restored.drain() } finally { restored.close() }
  assert.equal(agent.replay.source.exchangeId,id)
  assert.equal(taskBudgetReceipt(raw, 'session-worker', id).status, 'sent')
  resumed.botReply(id,'done after reset')
  assert.equal(raw.require('tasks',task.id).evidence,'done after reset')
  assert.equal(sessions.length,1)
  assert.equal(raw.forRun('messages',run.id).filter(row=>row.kind==='report').length,1)
})
