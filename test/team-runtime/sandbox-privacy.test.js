import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, sandboxAwareObserver, sandboxConversation, rememberSandboxSource } from '../../src/host/team-runtime/sandbox-privacy.js'

import * as review from '../../src/host/team-runtime/core/memory-review.js'
import * as learning from '../../src/host/team-runtime/core/learning.js'

function team() {
  const sandbox = { id:'sandbox', name:'Guest', model:'local-sandbox-antigravity-c/default', accountProfileId:'c' }
  const host = { id:'host', name:'Host', model:'cloud/default' }
  const bots = { host, sandbox }
  const rooms = {}
  const listeners = new Map(), disposers = []
  const requests = []
  const rt = {
    config:{ memoryReviewDelayMs:60000 }, state:{ bots, rooms, localAgents:{ sessions:{} } },
    ctx:{
      on(event, fn) { const entries = listeners.get(event) ?? []; entries.push(fn); listeners.set(event, entries) },
      effect(fn) { const close = fn(); if (close) disposers.push(close) },
    },
    botOf:id => bots[id], roomOf:id => rooms[id], selfOf:id => rt.chatOwners.get(id) ?? rt.groupOwners.get(id)?.botId,
    chatOf:id => bots[id]?.sessionId ?? id, isBotSession:id => rt.chatOwners.has(id) || rt.groupOwners.has(id),
    chatOwners:new Map([['host-part','host'], ['guest-part','sandbox']]), groupOwners:new Map(), roomOwners:new Map(), pastOwners:new Map(),
    assembleLlm(options) { requests.push(options); return 'sent' }, readOnly:() => undefined,
    warn() {}, save:async () => {}, ownRequest:request => request.tagged === true,
  }
  return { rt, bots, rooms, listeners, requests, status:(id,status) => listeners.get('agent/status').forEach(fn => fn({ agent:{ id }, status })), close:async () => { for (const fn of disposers) await fn() } }
}

test('pinned memory-review idle listener queues ordinary turns but skips sandbox turns and mixed rooms', async t => {
  const { rt, rooms, status, close } = team()
  t.after(close)
  let memoryReviews
  sandboxAwareObserver({ install(scoped) {
    ;({ memoryReviews } = review.installReview(scoped, { root:tmpdir(), reviewOn:true }))
  } }).install(rt)
  rooms.room = { id:'room', members:['host','sandbox'], log:[] }
  rt.groupOwners.set('host-in-room', { botId:'host', roomId:'room' })
  for (const id of ['guest-part','host-in-room']) {
    status(id,'running'); status(id,'idle')
  }
  assert.equal(memoryReviews(), 0)
  assert.equal(rt.state.localAgents.sandboxHistory.room, true)
  rooms.room.members = ['host']
  status('host-in-room','idle')
  assert.equal(memoryReviews(), 0)
  status('host-part','running'); status('host-part','idle')
  assert.equal(memoryReviews(), 1)
})

test('delayed and pre-upgrade transcripts are checked by original part, including during iteration', async () => {
  const { rt, bots, rooms } = team()
  rt.state.localAgents.sessions['old'] = { route:'local-sandbox-antigravity-c' }
  let scoped
  sandboxAwareObserver({ install(value) { scoped = value } }).install(rt)
  const read = []
  rt.partLines = async function* (id) { read.push(id); yield 'first'; yield 'second' }
  const collect = async iter => { const rows = []; for await (const row of iter) rows.push(row); return rows }
  assert.deepEqual(await collect(scoped.partLines('old')), [])
  assert.deepEqual(read, [])
  assert.deepEqual(await collect(rt.partLines('old')), ['first','second'])
  const iter = scoped.partLines('host-part')
  assert.equal((await iter.next()).value, 'first')
  rememberSandboxSource(rt,'host-part')
  assert.equal((await iter.next()).done, true)
  bots.sandbox = { id:'sandbox', segments:[{ sessionId:'old' }], model:'cloud/default' }
  rooms.past = { id:'past', members:['host'], segments:{ removed:[{ sessionId:'old' }] } }
  rt.pastOwners.set('past-group-root',{ roomId:'past' })
  assert.equal(sandboxConversation(rt,'past-group-root'), true)
  rooms.historic = { id:'historic', members:['host'], log:[{ botId:'sandbox', text:'previously in this room' }] }
  assert.equal(sandboxConversation(rt,'historic'), true)
  rooms.ledger = { id:'ledger', members:['host'] }
  rt.groupLinesAfter = async () => [{ botId:'sandbox', text:'only in the old ledger' }]
  assert.deepEqual(await scoped.groupLinesAfter('ledger'), [])
  assert.equal(rt.state.localAgents.sandboxHistory.ledger, true)
})

test('auxiliary streams retain their account boundary at assembly and dispatch, including DSH-generated calls', () => {
  const { rt, requests, listeners } = team()
  install(rt)
  assert.throws(() => rt.assembleLlm({ sessionId:'guest-part',provider:'cloud' }), /沙箱/)
  assert.equal(rt.assembleLlm({ sessionId:'host-part',provider:'cloud' }), 'sent')
  const [stream] = listeners.get('llm/stream')
  for (const flags of [{ purpose:'title' },{purpose:'compaction'},{tagged:true}]) {
    assert.throws(() => stream({ sessionId:'guest-part', provider:'cloud', ...flags }, assert.fail), /沙箱/)
  }
  assert.equal(stream({ sessionId:'guest-part', provider:'local-sandbox-antigravity-c', purpose:'title' }, () => 'guest'), 'guest')
  assert.equal(stream({ sessionId:'host-part', provider:'cloud', purpose:'title' }, () => 'host'), 'host')
  assert.equal(requests.length, 1)
})

test('pinned learning drains a pre-upgrade sandbox part and mixed project backlog without submitting either to the host', async t => {
  const { rt, bots, close } = team()
  const home = await mkdtemp(join(tmpdir(),'godbot-learning-privacy-'))
  t.after(async () => { await close(); await rm(home,{recursive:true,force:true}) })
  rt.home = home
  rt.config.agentsMd = true
  rt.config.learningTimes = { tickMs:60000 }
  const dir = join(home,'learning'), project = join(home,'shared-project'), other = join(home,'host-project')
  await Promise.all([dir,project,other].map(path => mkdir(path)))
  const statePath = join(dir,'state.json')
  // This source was archived and the owner has switched back to a host model.
  rt.state.localAgents.sessions['legacy-guest'] = { route:'local-sandbox-codex-c' }
  bots.sandbox = { id:'sandbox',name:'former sandbox',sessionId:'later-host',segments:[{ sessionId:'legacy-guest' }],model:'cloud/default' }
  await writeFile(statePath,JSON.stringify({
    pending:{ sandbox:['legacy-guest'] },
    agentsPending:{
      [project]:{botId:'host',records:[{ botId:'sandbox',text:'legacy sandbox text',order:0 }]},
      [other]:{botId:'host',records:[{ botId:'host',text:'ordinary host text',order:0 }]},
    },
    settled:{manual:{outcome:'approved'}},
  }))
  const chats = [], submitted = []
  rt.partLines = async function* (id) { chats.push(id); yield {seq:1,who:'user',text:'legacy sandbox text'} }
  rt.botShot = async (_bot,_system,prompt) => { submitted.push(prompt); return '{"action":"none"}' }
  rt.resolveAgent = async () => ({session:{}}); rt.sessionFolder = () => undefined
  sandboxAwareObserver(learning).install(rt)
  await rt.learningRun()
  assert.deepEqual(chats, [])
  assert.equal(submitted.length, 1)
  assert.match(submitted[0], /ordinary host text/)
  assert.doesNotMatch(submitted[0], /legacy sandbox text/)
  const after = JSON.parse(await readFile(statePath,'utf8'))
  assert.deepEqual(after.agentsPending, {})
  assert.deepEqual(after.pending, {})
  assert.deepEqual(after.settled, {manual:{outcome:'approved'}})
})
