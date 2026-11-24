import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExecutionHistory } from '../../src/host/team-runtime/execution-history.js'
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
