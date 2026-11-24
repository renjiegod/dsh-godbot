import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExecutionHistory } from '../../src/host/team-runtime/execution-history.js'
import { roomItems } from '../../src/host/team-runtime/core/mobile.js'
import { mobileToolDetail, mobileTurnProcess } from '../../src/host/team-runtime/mobile-tool-timeline.js'
import { stackReplies } from '../../src/host/team-runtime/shared/group-replies.js'

// A group member's work panel reads the process of the member's group Session.
test('a member\'s group Session keeps its process for that member only', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'godbot-member-work-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const rt = {
    home,
    botOf: id => ['worker', 'other'].includes(id) ? { id } : undefined,
    chatOwners: new Map([['part', 'worker']]),
    groupOwners: new Map([['member-part', { botId: 'worker', roomId: 'room' }]]),
    roomOwners: new Map([['group-part', 'room']]),
    pastOwners: new Map([['earlier-member-part', { botId: 'worker', roomId: 'room' }], ['earlier-group-part', { roomId: 'room' }]]),
    state: { localAgents: { sessions: {} } },
  }
  const history = new ExecutionHistory(rt)
  t.after(() => history.close())
  assert.equal(history.ownerOf('member-part'), 'worker')
  assert.equal(history.ownerOf('earlier-member-part'), 'worker')
  assert.equal(history.ownerOf('group-part'), undefined, 'a group\'s own Session belongs to no Bot')
  assert.equal(history.ownerOf('earlier-group-part'), undefined)

  const emit = (type, data, seq) => history.observe('member-part', { type, data: { ...data, turn: 7 }, seq, time: 20_000 + seq })
  emit('turn/start', {}, 1)
  // A local agent CLI's own tools, reported by the adapter, and a team tool DSH ran.
  history.record('member-part', { type: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'npm test -- --watch=false' }, status: 'running' })
  history.record('member-part', { type: 'tool', id: 'toolu_2', name: 'Read', text: 'src/app.js', input: { file_path: '/work/src/app.js' }, status: 'completed' })
  history.record('member-part', { type: 'tool', id: 'item_3', name: 'Shell', activityKind: 'read', input: 'cat notes.txt', status: 'completed' })
  emit('tool/call', { callId: 'godbot-mcp-1', name: 'read_group_chat', arguments: '{"group":"Promo"}' }, 2)
  emit('tool/result', { message: { toolCallId: 'godbot-mcp-1', content: [{ type: 'text', text: 'the chat' }] } }, 3)
  emit('tool/call', { callId: 'call-4', name: 'grep', arguments: '{"pattern":"TODO","path":"src","description":"Find open work"}' }, 4)
  const reading = await history.read({ botId: 'worker', sessionId: 'member-part', turn: 7 })
  assert.equal(reading.running, true)
  assert.deepEqual(reading.events.map(row => [row.name, row.status]),
    [['Bash', 'running'], ['Read', 'completed'], ['Shell', 'completed'], ['read_group_chat', 'completed'], ['grep', 'running']])
  // The summary leaves the input out. A call that names itself keeps that name, which the
  // chat shows; one that does not gets a `target` named from its input, as the chat would:
  // a command by its program only, a call with a description by that.
  assert.deepEqual(reading.events.map(row => [row.text, row.target, 'input' in row]), [
    [undefined, 'npm test', false],
    ['src/app.js', undefined, false],
    [undefined, 'cat', false],
    [undefined, undefined, false],
    [undefined, 'Find open work', false],
  ])
  history.record('member-part', { type: 'tool', id: 'toolu_1', status: 'completed', output: 'ok' })
  emit('tool/result', { message: { toolCallId: 'call-4', content: [{ type: 'text', text: 'none' }] } }, 5)
  emit('assistant/message', { message: { content: [{ type: 'text', text: 'Done: tests pass.' }] } }, 6)
  emit('turn/end', { reason: { kind: 'completed' } }, 7)
  const settled = await history.read({ botId: 'worker', sessionId: 'member-part', turn: 7 })
  assert.equal(settled.running, false)
  assert.deepEqual(settled.events.map(row => row.name ?? row.text), ['Bash', 'Read', 'Shell', 'read_group_chat', 'grep', 'Done: tests pass.'])
  await assert.rejects(history.read({ botId: 'other', sessionId: 'member-part', turn: 7 }))
  await assert.rejects(history.read({ botId: 'worker', sessionId: 'group-part', turn: 7 }))
})

test('a group line carries the turn it came from, and lines of two turns do not share a message', () => {
  const work = turn => ({ sessionId: 'member-part', turn, tools: turn })
  const line = (text, extra = {}) => ({ botId: 'worker', name: 'Worker', text, time: 1, ...extra })
  const stacked = stackReplies([
    line('Starting.', { work: work(3) }),
    line('Found it.', { work: { ...work(3), tools: 9 } }),
    line('Next turn.', { work: work(4) }),
    line('An older line with no turn.'),
  ])
  assert.deepEqual(stacked.map(item => [item.texts, item.work]), [
    [['Starting.', 'Found it.'], { sessionId: 'member-part', turn: 3, tools: 9 }],
    [['Next turn.', 'An older line with no turn.'], work(4)],
  ])
  assert.equal('work' in stackReplies([line('Plain.')])[0], false)
})

// The phone's work panel reads the same turn in one call and opens each call by itself.
test('a phone reads a member\'s turn as rows its work panel shows, without inputs or outputs', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'godbot-member-work-phone-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const rt = {
    home,
    botOf: id => ['worker', 'other'].includes(id) ? { id } : undefined,
    chatOwners: new Map([['part', 'worker']]),
    groupOwners: new Map([['member-part', { botId: 'worker', roomId: 'room' }]]),
    roomOwners: new Map([['group-part', 'room']]),
    pastOwners: new Map(),
    live: new Map([['member-part', { turn: 7 }]]),
    state: { localAgents: { sessions: {} }, exchangeTurns: { 'member-part': [5] } },
    redactSecrets: text => text.replaceAll('fixture-secret', '[redacted]'),
  }
  const history = rt.executionHistory = new ExecutionHistory(rt)
  t.after(() => history.close())
  const emit = (type, data, seq) => history.observe('member-part', { type, data: { ...data, turn: 7 }, seq, time: 30_000 + seq })
  emit('turn/start', {}, 1)
  history.record('member-part', { type: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'npm test fixture-secret' }, status: 'running' })
  history.record('member-part', { type: 'tool', id: 'toolu_2', name: 'Read', text: 'notes/fixture-secret.md', input: { file_path: '/work/notes/fixture-secret.md' }, status: 'completed' })
  emit('tool/call', { callId: 'ask-1', name: 'ask_user', arguments: '{"question":"Which one?"}' }, 2)
  emit('tool/result', { message: { toolCallId: 'ask-1', content: [{ type: 'text', text: 'the first' }] } }, 3)
  emit('tool/call', { callId: 'read-1', name: 'read_file', arguments: '{"path":"src/a.js"}' }, 4)
  emit('tool/result', { message: { toolCallId: 'read-1', isError: true, content: [{ type: 'text', text: 'missing' }] } }, 5)

  const args = { botId: 'worker', sessionId: 'member-part', turn: 7 }
  const first = await mobileTurnProcess(rt, args)
  assert.equal(first.running, true)
  // What a call works on reads as on the web: the name it carries, else the host's target.
  assert.deepEqual(first.events, [
    { type: 'tool', toolId: 'toolu_1', name: 'Bash', status: 'running', text: 'npm test' },
    { type: 'tool', toolId: 'toolu_2', name: 'Read', status: 'completed', text: 'notes/[redacted].md' },
    // An interactive call counts, as on the web, but opens no details here.
    { type: 'tool', name: 'ask_user', status: 'completed' },
    { type: 'tool', toolId: 'read-1', name: 'read_file', status: 'failed', text: 'src/a.js' },
  ])
  assert.ok(!/input|output|the first|missing/.test(JSON.stringify(first.events)), 'a call\'s body is read when its card opens')
  // Each call opens by itself through the chat's card call.
  assert.equal((await mobileToolDetail(rt, { ...args, toolId: 'read-1' })).output, JSON.stringify([{ type: 'text', text: 'missing' }], null, 2))
  // Reading again with nothing new answers with the name only.
  assert.deepEqual(await mobileTurnProcess(rt, { ...args, knownRev: first.rev }), { running: true, rev: first.rev, unchanged: true })

  history.record('member-part', { type: 'tool', id: 'toolu_1', status: 'completed', output: 'ok' })
  emit('assistant/message', { message: { content: [{ type: 'text', text: 'Done. ' + 'x'.repeat(5000) }] } }, 6)
  rt.live.delete('member-part')
  emit('turn/end', { reason: { kind: 'completed' } }, 7)
  const settled = await mobileTurnProcess(rt, { ...args, knownRev: first.rev })
  assert.notEqual(settled.rev, first.rev)
  assert.equal(settled.running, false)
  assert.equal(settled.events[0].status, 'completed')
  const said = settled.events.at(-1)
  assert.equal(said.type, 'text')
  assert.ok(said.text.startsWith('Done. ') && said.text.endsWith('…') && said.text.length === 4001)

  await assert.rejects(mobileTurnProcess(rt, { ...args, botId: 'other' }))
  await assert.rejects(mobileTurnProcess(rt, { ...args, sessionId: 'group-part' }), 'the group\'s own Session belongs to no Bot')
  await assert.rejects(mobileTurnProcess(rt, { ...args, turn: 5 }), 'a turn that answered another Bot stays hidden')
  await assert.rejects(mobileTurnProcess(rt, { ...args, turn: '7' }))
})

test('a phone\'s group rows name the member\'s turn they come from', () => {
  const work = { sessionId: 'member-part', turn: 4, tools: 6 }
  const rows = [
    { botId: 'worker', name: 'Worker', text: 'Looking.', time: 10, work },
    { botId: 'worker', name: 'Worker', kind: 'working', time: 11, work: { sessionId: 'member-part', turn: 4 } },
    { botId: 'worker', name: 'Worker', kind: 'done', time: 12, work: { ...work, tools: 0 } },
    { botId: 'worker', name: 'Worker', text: 'Before turns were named.', time: 13 },
    { botId: 'worker', name: 'Worker', text: 'Bad.', time: 14, work: { sessionId: 'member-part', turn: 'x' } },
  ]
  const events = [
    { seq: 1, type: 'user/message', time: 5, data: { source: { kind: 'bot', role: 'post', senderSessionId: 'worker', senderName: 'Worker', work }, content: [{ type: 'text', text: '[Group post from Worker]\nA post.' }] } },
    { seq: 2, type: 'tool/call', data: { name: 'group_relay', callId: 'relay-1' } },
    { seq: 3, type: 'tool/result', data: { message: { toolCallId: 'relay-1', content: [{ type: 'text', text: JSON.stringify({ from: 1 }) }] } } },
  ]
  const { items } = roomItems(events, () => rows)
  assert.deepEqual(items.map(item => [item.kind, item.event ?? item.text, item.work]), [
    ['bot', 'A post.', work],
    ['bot', 'Looking.', work],
    ['event', 'working', { sessionId: 'member-part', turn: 4 }],
    ['event', 'done', { sessionId: 'member-part', turn: 4 }],
    ['bot', 'Before turns were named.', undefined],
    ['bot', 'Bad.', undefined],
  ])
})
