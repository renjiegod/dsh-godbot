import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ClaudeTurns } from '../../src/drivers/external/claude-turns.js'
import { openExternal } from '../../src/drivers/external/index.js'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-claude-turns.mjs', import.meta.url))
const lifecycle = (uuid, state) => ({ type: 'command_lifecycle', command_uuid: uuid, state })
const taskOrigin = { kind: 'task-notification', producer: 'session-task' }

// The sequences below follow what Claude Code 2.1.330 printed in stream-json.
test('a resumed CLI reporting a task its predecessor left running does not answer the waiting prompt', () => {
  const turns = new ClaudeTurns()
  assert.equal(turns.write('p1'), 'p1')
  turns.observe({ type: 'system', subtype: 'task_notification', status: 'stopped' })
  turns.observe(lifecycle('p1', 'queued'))
  turns.observe({ type: 'system', subtype: 'init' })
  assert.equal(turns.settle({ kind: 'task-notification' }), undefined)
  assert.equal(turns.busy, true)
  turns.observe(lifecycle('p1', 'started'))
  turns.observe({ type: 'system', subtype: 'status', status: 'requesting', user_message_uuids: ['p1'] })
  assert.deepEqual(turns.tag({ type: 'text', text: 'PONG' }), { type: 'text', text: 'PONG', turnId: 'p1' })
  assert.deepEqual(turns.settle(undefined), { turn: 'p1', finished: ['p1'] })
  turns.observe(lifecycle('p1', 'completed'))
  assert.equal(turns.busy, false)
})

test('a turn the CLI starts by itself is background activity, idle or ahead of a queued prompt', () => {
  const turns = new ClaudeTurns()
  turns.write('p1')
  turns.observe(lifecycle('p1', 'queued'))
  turns.observe(lifecycle('p1', 'started'))
  assert.deepEqual(turns.settle(undefined), { turn: 'p1', finished: ['p1'] })
  turns.observe(lifecycle('p1', 'completed'))
  // A background task ends while nothing waits.
  turns.observe({ type: 'system', subtype: 'status', status: 'requesting' })
  // Its output answers no prompt, and comes whole for the turn that shows it.
  assert.deepEqual(turns.tag({ type: 'text', text: 'the task finished' }), { type: 'background', of: 'text', event: { type: 'text', text: 'the task finished' } })
  assert.deepEqual(turns.tag({ type: 'context', used: 9 }), { type: 'context', used: 9 })
  assert.equal(turns.settle(taskOrigin), undefined)
  // Another one runs when a prompt arrives: the prompt waits behind it.
  turns.write('p2')
  turns.observe(lifecycle('p2', 'queued'))
  assert.deepEqual(turns.tag({ type: 'tool', name: 'Bash' }), { type: 'background', of: 'tool', event: { type: 'tool', name: 'Bash' } })
  assert.equal(turns.settle(taskOrigin), undefined)
  turns.observe(lifecycle('p2', 'started'))
  assert.equal(turns.tag({ type: 'text', text: 'answer' }).turnId, 'p2')
  assert.deepEqual(turns.settle(undefined), { turn: 'p2', finished: ['p2'] })
})

test('a steer the CLI folds into the running turn is answered by that turn, even if it completes first', () => {
  const turns = new ClaudeTurns()
  turns.write('p1')
  turns.observe(lifecycle('p1', 'queued'))
  turns.observe(lifecycle('p1', 'started'))
  assert.equal(turns.write('s1', true), 'p1')
  turns.observe(lifecycle('s1', 'queued'))
  turns.observe({ type: 'user', isReplay: true, uuid: 's1' })
  turns.observe(lifecycle('s1', 'started'))
  assert.equal(turns.observe(lifecycle('s1', 'completed')), undefined)
  assert.equal(turns.tag({ type: 'text', text: 'DONE1 STEER2' }).turnId, 'p1')
  assert.deepEqual(turns.settle(undefined), { turn: 'p1', finished: ['p1'] })
  turns.observe(lifecycle('p1', 'completed'))
  assert.equal(turns.busy, false)
})

test('a steer the CLI runs as the next turn keeps its prompt open until that turn ends', () => {
  const turns = new ClaudeTurns()
  turns.write('p3')
  turns.observe(lifecycle('p3', 'queued'))
  turns.observe(lifecycle('p3', 'started'))
  assert.equal(turns.write('s2', true), 'p3')
  turns.observe(lifecycle('s2', 'queued'))
  assert.deepEqual(turns.settle(undefined), { turn: 'p3', finished: [] })
  assert.equal(turns.busy, true)
  turns.observe(lifecycle('p3', 'completed'))
  turns.observe(lifecycle('s2', 'started'))
  assert.equal(turns.tag({ type: 'text', text: 'PONG' }).turnId, 'p3')
  assert.deepEqual(turns.settle(undefined), { turn: 'p3', finished: ['p3'] })
  // A later prompt is a turn of its own, not a steer of the finished one.
  assert.equal(turns.write('p4', true), 'p4')
})

test('only the latest prompt can be steered while a stopped one is still finishing', () => {
  const turns = new ClaudeTurns()
  turns.write('stopped')
  turns.observe(lifecycle('stopped', 'queued'))
  turns.observe(lifecycle('stopped', 'started'))
  // The user stopped that prompt and sent a new one before its turn ended.
  turns.write('next')
  turns.observe(lifecycle('next', 'queued'))
  assert.equal(turns.busy, true)
  assert.deepEqual(turns.settle(undefined), { turn: 'stopped', finished: ['stopped'] })
  turns.observe(lifecycle('next', 'started'))
  assert.equal(turns.tag({ type: 'text', text: 'answer' }).turnId, 'next')
  assert.deepEqual(turns.settle(undefined), { turn: 'next', finished: ['next'] })
  assert.equal(turns.busy, false)
})

test('without lifecycle reports a result answers everything written since the previous one', () => {
  const turns = new ClaudeTurns()
  turns.write('p1')
  assert.equal(turns.tag({ type: 'text', text: 'ok' }).turnId, 'p1')
  assert.deepEqual(turns.settle(undefined), { turn: 'p1', finished: ['p1'] })
  assert.deepEqual(turns.tag({ type: 'text', text: 'later' }), { type: 'background', of: 'text', event: { type: 'text', text: 'later' } })
  assert.equal(turns.settle(undefined), undefined)
})

test('a prompt whose message leaves the queue without running ends, and a result without origin still answers', () => {
  const dropped = new ClaudeTurns()
  dropped.write('p1')
  dropped.observe(lifecycle('p1', 'queued'))
  assert.equal(dropped.observe(lifecycle('p1', 'completed')), 'p1')
  assert.equal(dropped.busy, false)
  // A CLI that reported the message but not its start: a result that names no
  // origin answers the prompt rather than leaving it waiting forever.
  const unreported = new ClaudeTurns()
  unreported.write('p1')
  unreported.observe(lifecycle('p1', 'queued'))
  assert.deepEqual(unreported.settle(undefined), { turn: 'p1', finished: ['p1'] })
})

async function drain(session, until) {
  const events = []
  for (;;) {
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), 5000) })
    const event = await Promise.race([session.next(), timeout]).finally(() => clearTimeout(timer))
    events.push(event)
    if (event.type === 'error') throw event.error
    if (until(event)) return events
  }
}
const textOf = events => events.filter(event => event.type === 'text').map(event => event.text).join('')

test('the team Claude engine keeps a self-started turn and a queued steer out of the wrong prompt', { timeout: 15000 }, async (t) => {
  const engine = createWorkspaceClaudeEngine('claude-code', { name: 'Claude Code', command: 'claude', args: [fixture] }, { findExecutable: () => process.execPath })
  t.after(() => engine.close())
  const session = await engine.open('turns', { cwd: tmpdir() })

  const first = await engine.prompt(session, [{ type: 'text', text: 'BACKGROUND task' }])
  const started = await drain(session, event => event.type === 'done')
  assert.equal(started.at(-1).turnId, first)
  assert.equal(textOf(started), 'started a background task')
  // The task ends and wakes the model while no prompt waits.
  const woke = await drain(session, event => event.type === 'background' && event.of === 'result')
  assert.ok(!woke.some(event => ['text', 'done'].includes(event.type)))
  // What it says comes whole for the turn that shows it, and its end brings the usage.
  assert.equal(woke.filter(event => event.type === 'background' && event.of === 'text').map(event => event.event.text).join(''), 'autonomous: the background task finished')
  assert.deepEqual(woke.at(-1).usage, { inputTokens: 3, outputTokens: 2 })
  assert.equal(session.running, false)

  const next = await engine.prompt(session, [{ type: 'text', text: 'next' }])
  const answer = await drain(session, event => event.type === 'done')
  assert.equal(textOf(answer), 'reply: next')
  assert.ok(answer.filter(event => event.type === 'text' || event.type === 'done').every(event => event.turnId === next))

  // A steer the CLI runs after the answer it could not join.
  const streamed = await engine.prompt(session, [{ type: 'text', text: 'STREAM please' }])
  await drain(session, event => event.type === 'text')
  assert.equal(engine.canSteer(session), true)
  await engine.steer(session, 'and then PONG')
  const both = await drain(session, event => event.type === 'done')
  assert.equal(both.filter(event => event.type === 'done').length, 1)
  assert.match(textOf(both), /streams slowly.*reply: and then PONG$/su)
  assert.ok(both.filter(event => event.type === 'text' || event.type === 'done' || event.type === 'usage').every(event => event.turnId === streamed))
  assert.equal(session.running, false)

  // A steer the CLI folds into the running turn.
  const merged = await engine.prompt(session, [{ type: 'text', text: 'MERGE please' }])
  await drain(session, event => event.type === 'activity')
  await engine.steer(session, 'also this')
  const folded = await drain(session, event => event.type === 'done')
  assert.equal(textOf(folded), 'merged: also this')
  assert.equal(folded.at(-1).turnId, merged)
})

test('a direct Claude endpoint answers the prompt, not the leftover task its resumed CLI reports first', { timeout: 15000 }, async (t) => {
  const events = []
  let notify
  const endpoint = await openExternal({
    kind: 'claude', cwd: process.cwd(), resumeId: `orphan-${randomUUID()}`,
    config: { command: process.execPath, args: [fixture] },
    onEvent(event) { events.push(event); notify?.() },
  })
  t.after(() => endpoint.close())
  const until = async (match) => {
    for (let wait = 0; wait < 200 && !events.some(match); wait++) await new Promise(resolve => { notify = resolve; setTimeout(resolve, 25) })
    return events.find(match)
  }
  await endpoint.start({ turnId: 'A', text: 'how much longer' })
  const done = await until(event => event.type === 'done' && event.turnId === 'A')
  assert.equal(done?.status, 'completed')
  assert.equal(events.filter(event => event.type === 'text' && event.turnId === 'A').map(event => event.text).join(''), 'reply: how much longer')

  await endpoint.start({ turnId: 'B', text: 'BACKGROUND task' })
  await until(event => event.type === 'done' && event.turnId === 'B')
  await new Promise(resolve => setTimeout(resolve, 300))
  await endpoint.start({ turnId: 'C', text: 'next' })
  await until(event => event.type === 'done' && event.turnId === 'C')
  assert.equal(events.filter(event => event.type === 'text' && event.turnId === 'C').map(event => event.text).join(''), 'reply: next')
  assert.ok(!events.some(event => event.type === 'text' && /autonomous/.test(event.text)))
})
