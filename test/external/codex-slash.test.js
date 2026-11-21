import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexEngine } from '../../src/drivers/external/codex.js'

function fixture(request) {
  const engine = new CodexEngine('test', {}, {})
  const thread = engine.threadFor('member')
  thread.threadId = 'active-thread'
  engine.peer = { request }
  return { engine, thread }
}

test('inline review binds the RPC turn, ignores the nested start, and renders the verdict once', async () => {
  const { engine, thread } = fixture(async (method, params) => {
    assert.equal(method, 'review/start')
    assert.deepEqual(params, { threadId:'active-thread', delivery:'inline', target:{type:'uncommittedChanges'} })
    engine.onNotice('item/started', {threadId:thread.threadId, turnId:'review', item:{type:'enteredReviewMode'}})
    engine.onNotice('turn/started', {threadId:thread.threadId,turn:{id:'nested'}})
    return {turn:{id:'review'}, reviewThreadId:thread.threadId}
  })
  const id = await engine.prompt(thread, [{type:'native-command',name:'review'}], {})
  assert.equal(id, 'review')
  assert.equal(thread.turnId, id)
  engine.onNotice('turn/started', {threadId:thread.threadId, turn:{id:'nested'}})
  assert.equal(thread.turnId, id)
  for (const item of [{type:'exitedReviewMode', review:'The review result'}, {type:'agentMessage',text:'The review result'}])
    engine.onNotice('item/completed', {threadId:thread.threadId,turnId:id,item})
  engine.onNotice('turn/completed', {threadId:thread.threadId,turn:{id,status:'completed'}})
  const events = []
  do { events.push(await thread.next()) } while (events.at(-1).type !== 'done')
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.text), ['The review result'])
  assert.equal(thread.turnId, undefined)
})

test('custom review uses a typed target; commands cannot be steered into an unrelated model turn', async () => {
  const { engine, thread } = fixture(async (_method, params) => {
    assert.deepEqual(params.target, {type:'custom',instructions:'Review math.'})
    return {turn:{id:'review'}, reviewThreadId:'active-thread'}
  })
  const command = [{type:'native-command',name:'review',args:'Review math.'}]
  assert.equal(await engine.prompt(thread, command, {}), 'review')
  await assert.rejects(engine.steer(thread, command), /单独的回合/)
  await assert.rejects(engine.prompt(thread, command, {}), /当前 Codex 回合/)
})

test('compact gets its id from a context-compaction item, including same-batch completion', async () => {
  const { engine, thread } = fixture(async (method, params) => {
    assert.equal(method, 'thread/compact/start')
    assert.deepEqual(params, {threadId:'active-thread'})
    engine.onNotice('item/started', {threadId:thread.threadId,turnId:'old',item:{type:'contextCompaction'}})
    engine.onNotice('item/started', {threadId:thread.threadId,turnId:'manual',item:{type:'contextCompaction'}})
    engine.onNotice('turn/completed', {threadId:thread.threadId,turn:{id:'manual',status:'completed'}})
    return {}
  })
  thread.completedTurnId = 'old'
  const id = await engine.prompt(thread, [{type:'native-command',name:'compact'}], {})
  assert.equal(id, 'manual')
  assert.equal(thread.turnId, undefined)
  assert.equal(thread.slashOperation, undefined)
})

test('empty thread cannot queue an unfinishable compact and compact does not silently ignore arguments', async () => {
  const { engine, thread } = fixture(async (method) => {
    assert.equal(method, 'thread/read')
    return {thread:{turns:[]}}
  })
  await assert.rejects(engine.prompt(thread, [{type:'native-command',name:'compact'}], {}), /没有可压缩/)
  await assert.rejects(engine.prompt(thread, [{type:'native-command',name:'compact',args:'text'}], {}), /不接收参数/)
})
