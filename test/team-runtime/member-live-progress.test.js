import assert from 'node:assert/strict'
import test from 'node:test'
import { install } from '../../src/host/team-runtime/core/turns.js'
import { fakeContext } from './fake-ctx.js'

// A group member's turn, as the group's details read it: what it runs now, how many
// tools it ran, and its newest calls. A local agent CLI (Claude Code, Codex) runs its
// own tools inside one model request, so they reach the host only as traces.
function memberTurn(t) {
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  const sessionId = 'member-session'
  const calls = { touched: 0, worked: [], live: 0 }
  const rt = {
    ctx,
    state: { exchangeTurns: {}, bots: {}, rooms: {} },
    groupOwners: new Map([[sessionId, { roomId: 'room', botId: 'claude' }]]),
    chatOwners: new Map(),
    isBotSession: id => id === sessionId,
    roomOf: () => undefined,
    selfOf: () => 'claude',
    botOf: () => undefined,
    switchJobs: () => [],
    approvalsView: () => [],
    touchRoomTurn: () => { calls.touched += 1 },
    workRoomTurn: (_, tool) => { calls.worked.push(tool) },
    liveChanged: () => { calls.live += 1 },
    save: async () => {},
    warn: () => {},
  }
  install(rt)
  const session = { id: sessionId }
  const emit = (type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener(session, { type, time: 1000, data })
  }
  const work = () => rt.roomWorkView().room?.find(entry => entry.botId === 'claude')
  return { rt, emit, work, calls, sessionId }
}

test('a DSH tool call ends on its result, which names the call on its message', (t) => {
  const { emit, work } = memberTurn(t)
  emit('turn/start', { turn: 1 })
  emit('tool/call', { turn: 1, step: 1, callId: 'godbot-mcp-1', name: 'read_group_chat', arguments: '{"group":"Promo"}' })
  assert.equal(work().tool, 'read_group_chat')
  emit('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'godbot-mcp-1', content: [{ type: 'text', text: 'ok' }] } })
  const entry = work()
  assert.equal(entry.tool, undefined, 'a finished call is no longer what the member is doing')
  assert.equal(entry.count, 1)
  assert.deepEqual(entry.recent, [{ tool: 'read_group_chat', status: 'completed' }])
})

test('a local agent CLI\'s own tools show as the member\'s work while its model request runs', (t) => {
  const { rt, emit, work, calls, sessionId } = memberTurn(t)
  emit('turn/start', { turn: 1 })
  emit('tool/call', { turn: 1, step: 1, callId: 'godbot-mcp-1', name: 'read_group_chat', arguments: '{}' })
  emit('tool/result', { turn: 1, step: 1, message: { toolCallId: 'godbot-mcp-1', content: [] } })
  emit('step/end', { turn: 1, step: 1 })
  emit('step/start', { turn: 1, step: 2 })
  const touched = calls.touched

  // Claude Code: the block start names the tool, its complete block adds the input.
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'toolu_1', name: 'Bash', status: 'running', text: 'npm' })
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'toolu_1', name: 'Bash', text: 'npm', input: { command: 'npm test', description: 'Run the unit tests' } })
  let entry = work()
  assert.equal(entry.tool, 'Bash')
  assert.equal(entry.note, 'Run the unit tests')
  assert.equal(entry.said, undefined, 'the step before the native tool did not say this')
  assert.equal(entry.count, 2, 'the native tool counts once, not per trace')
  assert.ok(calls.touched > touched, 'the round hears from the member while it works')
  assert.deepEqual(calls.worked, ['read_group_chat', 'Bash'])
  assert.ok(calls.live > 0)

  rt.noteNativeTool(sessionId, { type: 'tool', id: 'toolu_1', name: 'Bash', status: 'failed', exitCode: 1 })
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'toolu_2', name: 'Read', status: 'running', text: '/repo/src/app.js', input: { file_path: '/repo/src/app.js' } })
  entry = work()
  assert.equal(entry.tool, 'Read')
  assert.equal(entry.target, 'app.js')
  assert.deepEqual(entry.recent, [
    { tool: 'read_group_chat', status: 'completed' },
    { tool: 'Bash', note: 'Run the unit tests', target: 'npm', status: 'failed' },
    { tool: 'Read', target: 'app.js', status: 'running' },
  ])

  rt.noteNativeTool(sessionId, { type: 'tool', id: 'toolu_2', status: 'completed' })
  assert.equal(work().tool, undefined)
  // A result for a call this turn never started, with no name, changes nothing.
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'toolu_9', status: 'completed' })
  assert.equal(work().recent.length, 3)
  // A tool reported only once done (a Codex file change) still counts once.
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'edit-1', name: 'Edit', status: 'completed' })
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'edit-1', name: 'Edit', status: 'completed' })
  assert.equal(work().count, 4)
  assert.deepEqual(work().recent.at(-1), { tool: 'Edit', status: 'completed' })
})

test('the newest calls are bounded and a new turn starts with none', (t) => {
  const { rt, emit, work, sessionId } = memberTurn(t)
  emit('turn/start', { turn: 1 })
  for (let index = 1; index <= 8; index++) {
    rt.noteNativeTool(sessionId, { type: 'tool', id: `t${index}`, name: 'Bash', status: 'running', input: { command: `step ${index}` } })
    rt.noteNativeTool(sessionId, { type: 'tool', id: `t${index}`, status: 'completed' })
  }
  assert.equal(work().count, 8)
  assert.equal(work().recent.length, 5)
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'left', name: 'Bash', status: 'running' })
  emit('turn/start', { turn: 2 })
  const entry = work()
  assert.equal(entry.count, undefined)
  assert.equal(entry.recent, undefined)
  assert.equal(entry.tool, undefined)
})

test('a member at work names its group Session and turn, which its work panel reads', (t) => {
  const { rt, emit, work, sessionId } = memberTurn(t)
  emit('turn/start', { turn: 4 })
  rt.noteNativeTool(sessionId, { type: 'tool', id: 'toolu_1', name: 'Bash', status: 'running', input: { command: 'npm test' } })
  const entry = work()
  assert.equal(entry.sessionId, sessionId)
  assert.equal(entry.turn, 4)
  // The turn a group line comes from: the running one while it runs ...
  assert.deepEqual(rt.turnWork(sessionId), { sessionId, turn: 4, tools: 1 })
  emit('turn/end', { turn: 4, reason: { kind: 'completed' } })
  // ... and once it ended, the one it ended last, for its late reply.
  assert.equal(work(), undefined)
  assert.deepEqual(rt.turnWork(sessionId), { sessionId, turn: 4, tools: 1 })
  emit('turn/start', { turn: 5 })
  assert.deepEqual(rt.turnWork(sessionId), { sessionId, turn: 5 })
  assert.equal(rt.turnWork('another-session'), undefined)
})
