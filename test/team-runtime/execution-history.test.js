import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ExecutionHistory } from '../../src/host/team-runtime/execution-history.js'
import { toolReference } from '../../src/host/team-runtime/shared/tool-timeline.js'
import { mobileToolDetail, mobileToolRows, withLiveAttempt } from '../../src/host/team-runtime/mobile-tool-timeline.js'
import { readAntigravityToolResult } from '../../src/host/team-runtime/antigravity-tool-result.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'godbot-execution-history-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return {
    home,
    botOf: id => ['worker', 'other'].includes(id) ? { id } : undefined,
    chatOwners: new Map([['part', 'worker'], ['other-part', 'other']]),
    groupOwners: new Map([['room-part', { botId: 'other', roomId: 'room' }]]),
    pastOwners: new Map([['past', { botId: 'worker' }]]),
    state: { localAgents: { sessions: {} } },
    redactSecrets: text => text.replaceAll('fixture-secret', '[redacted]'),
  }
}

test('phone cards recover legacy start positions and fetch only their own visible tool details', async t => {
  const rt = await fixture(t)
  const history = rt.executionHistory = new ExecutionHistory(rt)
  t.after(() => history.close())
  rt.state.exchangeTurns = { part: [3] }
  const ids = ['first', 'second']
  for (const [i, id] of ids.entries()) history.record('part', {
    type: 'tool', id, name: 'Read', status: i ? 'failed' : 'completed', output: 'fixture-secret ' + 'x'.repeat(9000),
  }, 2)
  const first = { type: 'reasoning', text: '▸ Read · a · 调用' }
  const second = { type: 'reasoning', text: '▸ Read · b · 调用\n▸ Read · b · 失败\n▸ Read · a · 完成' }
  const content = [{ type: 'text', text: 'Before' }, first, { type: 'text', text: 'After' }, second]
  const event = { seq: 4, type: 'assistant/message', data: { turn: 2, step: 1, message: { content } } }
  const rows = mobileToolRows(rt, 'part', [event])
  assert.deepEqual([first, second].map(anchor => rows.get(anchor).map(row => [row.toolId, row.text, row.status])), [
    [['first', 'a', 'completed']], [['second', 'b', 'failed']],
  ])
  assert.ok(!JSON.stringify([...rows.values()]).includes('output'))
  const args = { sessionId: 'part', botId: 'worker', turn: 2, toolId: 'first' }
  const detail = await mobileToolDetail(rt, args)
  assert.ok(detail.output.startsWith('[redacted]') && detail.output.endsWith('…') && detail.output.length <= 8193)
  await assert.rejects(mobileToolDetail(rt, { ...args, botId: 'other' }))
  await assert.rejects(mobileToolDetail(rt, { ...args, turn: 3 }))
  assert.equal(mobileToolRows(rt, 'part', [{ ...event, data: { ...event.data, turn: 3 } }]).size, 0)
})

test('a phone reopening mid-attempt gets the visible blocks at the stream cut, then exactly one saved message', () => {
  const turn = 7, step = 2
  const before = { seq: 4, type: 'step/start', data: { turn, step } }
  const after = { seq: 6, type: 'user/message', data: {} }
  const activity = toolReference('▸ Bash · 调用', 'call')
  const attempt = { startedAfterSeq: 4, turn, step, stream: [
    { type: 'text-chunks', time0: 5, index: 0, dt: [0], texts: ['Check'] },
    { type: 'reasoning-chunks', time0: 6, index: 1, dt: [0], texts: [activity] },
  ] }
  const [, live, steer] = withLiveAttempt([before, after], attempt)
  assert.deepEqual(live.data.message.content, [{ type: 'text', text: 'Check' }, { type: 'reasoning', text: activity }])
  assert.equal(steer, after)
  const saved = [before, after, { ...live, seq: 7 }]
  assert.equal(withLiveAttempt(saved, attempt), saved)
})

test('execution history updates one row per call and reads its details across restart', async (t) => {
  const rt = await fixture(t)
  const part = { botId: 'worker', sessionId: 'part', turn: 2 }
  const first = new ExecutionHistory(rt)
  const emit = (type, data, seq) => first.observe('part', { type, data: { ...data, turn: 2 }, seq, time: 10_000 + seq })
  emit('turn/start', {}, 1)
  first.record('part', { type: 'tool', id: 'shell', name: 'Shell', input: { command: 'npm test' }, status: 'running' })
  first.record('part', { type: 'tool', id: 'shell', outputDelta: 'tests\n' })
  first.record('part', { type: 'tool', id: 'shell', outputDelta: 'fixture-secret' })
  emit('tool/call', { callId: 'dsh-1', name: 'find', arguments: '{"query":"tests"}' }, 2)
  emit('tool/result', { message: { toolCallId: 'dsh-1', content: [{ type: 'text', text: 'found tests' }] } }, 3)
  assert.deepEqual((await first.read(part)).events.map(row => [row.name, row.status, row.output]), [
    ['Shell', 'running', undefined], ['find', 'completed', undefined],
  ])
  assert.equal((await first.read({ ...part, toolId: 'shell' })).events[0].output, 'tests\n[redacted]')
  first.record('part', { type: 'tool', id: 'shell', status: 'failed', exitCode: 1 })
  emit('assistant/message', { message: { content: [{ type: 'text', text: 'Full report.' }] } }, 4)
  emit('turn/end', { reason: { kind: 'completed' } }, 5)
  first.close()

  const reopened = new ExecutionHistory(rt)
  t.after(() => reopened.close())
  const replay = await reopened.read(part)
  assert.equal(replay.running, false)
  assert.deepEqual(replay.events.map(row => row.name ?? row.text), ['Shell', 'find', 'Full report.'])
  assert.equal(replay.events[0].exitCode, 1)
  assert.deepEqual((await reopened.read({ ...part, toolId: 'dsh-1' })).events[0].output, [{ type: 'text', text: 'found tests' }])
  await assert.rejects(reopened.read({ ...part, botId: 'other' }), /私聊/)
  // Another member's group Session is that member's work, not this one's.
  await assert.rejects(reopened.read({ ...part, sessionId: 'room-part' }), /私聊/)
})

test('execution history respects DSH command failures in new and existing shell receipts', async (t) => {
  const rt = await fixture(t)
  const history = new ExecutionHistory(rt)
  t.after(() => history.close())
  const part = { botId: 'worker', sessionId: 'part', turn: 2 }
  const emit = (type, data) => history.observe('part', { type, data: { ...data, turn: 2 } })
  const output = [{ type: 'text', text: 'shell output\n[exit code: 128]' }]
  emit('turn/start', {})
  for (const [name, id, meta] of [['bash', 'shell'], ['pwsh', 'structured', { exitCode: 0 }], ['read', 'read']]) {
    emit('tool/call', { callId: id, name, arguments: '{}' })
    emit('tool/result', { message: { toolCallId: id, isError: false, content: output }, meta })
  }
  history.database().prepare('INSERT INTO execution_events(part, turn, identity, data) VALUES (?, ?, ?, ?)').run(
    'part', 2, 'tool:old', JSON.stringify({ type: 'tool', id: 'old', name: 'bash', status: 'completed', output }),
  )
  emit('turn/end', { reason: { kind: 'completed' } })
  const events = (await history.read(part)).events
  assert.deepEqual(events.map(({ id, status, exitCode }) => [id, status, exitCode]), [
    ['shell', 'failed', 128], ['structured', 'completed', 0], ['read', 'completed', undefined], ['old', 'failed', 128],
  ])
  assert.deepEqual((await history.read({ ...part, toolId: 'old' })).events[0].output, output)
})

test('execution history preserves assistant and tool positions after updates and restart', async t => {
  const rt = await fixture(t)
  const history = new ExecutionHistory(rt)
  const part = { botId: 'worker', sessionId: 'part', turn: 2 }
  let seq = 0
  const observe = (type, data = {}) => history.observe('part', { type, data: { ...data, turn: 2 }, seq: ++seq })
  observe('turn/start')
  history.record('part', { type: 'tool', id: 'a', name: 'Read', status: 'running', activityKind: 'skill' })
  history.record('part', { type: 'tool', id: 'b', name: 'Read', status: 'running' })
  assert.deepEqual((await history.read({ ...part, onlyTools: true })).events.map(row => row.status), ['running', 'running'])
  history.record('part', { type: 'tool', id: 'b', status: 'completed' })
  history.record('part', { type: 'tool', id: 'a', status: 'failed' })
  history.record('part', { type: 'tool', id: 'mirror', name: 'mcp_godbot_find', status: 'completed' })
  observe('assistant/message', { message: { content: [
    { type: 'text', text: 'Starting' },
    { type: 'reasoning', text: toolReference('▸ Read · a · 调用', 'a') },
    { type: 'text', text: 'Continuing' },
    { type: 'reasoning', text: toolReference('▸ Read · b · 调用', 'b') },
    { type: 'reasoning', text: '▸ mcp_godbot_find · 完成' },
    { type: 'tool-call', id: 'godbot-host' },
  ] } })
  observe('tool/call', { callId: 'godbot-host', name: 'find' })
  observe('tool/result', { message: { toolCallId: 'godbot-host', content: 'found' } })
  observe('assistant/message', { message: { content: [{ type: 'text', text: 'Finished' }] } })
  observe('turn/end')
  history.close()
  const reopened = new ExecutionHistory(rt)
  t.after(() => reopened.close())
  const tools = (await reopened.read({ ...part, onlyTools: true })).events
  assert.equal(tools.find(tool => tool.id === 'a').activityKind, 'skill')

  assert.deepEqual((await reopened.read(part)).events.map(row => row.type === 'text' ? row.text : [row.id, row.status]), [
    'Starting', ['a', 'failed'], 'Continuing', ['b', 'completed'], ['godbot-host', 'completed'], 'Finished',
  ])
})

test('existing turns use saved reasoning positions to recover legacy tool receipts', async t => {
  const rt = await fixture(t)
  const history = new ExecutionHistory(rt)
  t.after(() => history.close())
  const part = { botId: 'worker', sessionId: 'part', turn: 2 }
  const content = [
    { type: 'text', text: 'Check the screenshot' },
    { type: 'reasoning', text: '▸ Bash · locate screenshots · 调用\n▸ Bash · locate screenshots · 完成\n▸ Read · screenshot.png · 调用' },
    { type: 'text', text: 'The screenshot looks right' },
    { type: 'reasoning', text: '▸ Read · screenshot.png · 完成\n▸ Bash · final checks · 调用\n▸ Bash · final checks · 完成' },
  ]
  rt.ctx = { sessionController: { page: async () => ({ records: [
    { type: 'turn/start', data: { turn: 2 }, seq: 1 },
    { type: 'assistant/message', data: { turn: 2, message: { content } }, seq: 2 },
    { type: 'turn/end', data: { turn: 2 }, seq: 3 },
  ].map(event => ({ event })) }) } }
  for (const [id, name] of [['locate', 'Bash'], ['screenshot', 'Read'], ['check', 'Bash']]) {
    history.record('part', { type: 'tool', id, name, status: 'completed', output: id }, 2)
  }
  history.database().prepare('INSERT INTO execution_events(part, turn, identity, data) VALUES (?, ?, ?, ?)').run(
    'part', 2, 'message:2', JSON.stringify({ type: 'text', text: 'Check the screenshot\n\nThe screenshot looks right' }),
  )
  assert.deepEqual((await history.read(part)).events.map(row => row.type === 'tool' ? row.id : row.text), [
    'Check the screenshot', 'locate', 'screenshot', 'The screenshot looks right', 'check',
  ])
})

test('archived Claude report links to its retained native tool bodies', async (t) => {
  const rt = await fixture(t)
  const startedAt = '2026-11-20T03:00:00.000Z'
  const report = 'This saved assistant report is long enough to identify a unique historical Claude turn with confidence.'
  rt.state.localAgents.sessions.past = { route: 'local-claude-code', cwd: rt.home, cliSessionId: 'exact-native-session' }
  rt.ctx = { sessionController: { page: async ({ address }) => {
    assert.equal(address.sessionId, 'past')
    return { records: [
      { type: 'turn/start', data: { turn: 5 }, time: Date.parse(startedAt), seq: 1 },
      { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: report }] } }, seq: 2 },
      { type: 'turn/end', data: { turn: 5 }, seq: 3 },
    ].map(event => ({ event })) }
  } } }
  const readClaude = async binding => {
    assert.equal(binding.nativeId, 'exact-native-session')
    return [{ nativeTurnId: 'saved', startedAt, events: [
      { type: 'tool', id: 'read', seq: 1, name: 'Read', status: 'running', input: { file_path: 'app.js' } },
      { type: 'tool', id: 'read', seq: 2, status: 'completed', output: 'file contents' },
      { type: 'text', text: report, seq: 3 },
    ] }]
  }
  const history = new ExecutionHistory(rt, { readClaude })
  t.after(() => history.close())
  const scoped = { botId: 'worker', sessionId: 'past' }
  assert.deepEqual((await history.read(scoped)).turns.map(row => row.turn), [5])
  assert.deepEqual((await history.read({ ...scoped, turn: 5 })).events.map(row => row.type), ['tool', 'text'])
  assert.equal((await history.read({ ...scoped, turn: 5, toolId: 'read' })).events[0].output, 'file contents')
})

function protobufField(number, value) {
  function varint(value) {
    const bytes = []
    while (value >= 128) {
      bytes.push((value % 128) + 128)
      value = Math.floor(value / 128)
    }
    return Buffer.from([...bytes, value])
  }
  const bytes = Buffer.from(value)
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes])
}

test('Antigravity details backfill the exact owned ACP call without replacing reported output', async (t) => {
  const rt = await fixture(t)
  const nativeId = '00000000-1234-4000-abcd-000000000001'
  const otherId = '00000000-1234-4000-abcd-000000000002'
  const binding = { route: 'local-antigravity', cliSessionId: nativeId }
  rt.state.localAgents.sessions.part = binding
  const conversations = join(rt.home, 'conversations')
  await mkdir(conversations)
  const db = new DatabaseSync(join(conversations, nativeId + '.db'))
  db.exec(`CREATE TABLE trajectory_meta (cascade_id TEXT);
    CREATE TABLE steps (step_type INTEGER, step_format INTEGER, status INTEGER, metadata BLOB, error_details BLOB, step_payload BLOB);`)
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(nativeId)
  const field = protobufField
  const append = (id, name, result, { error, conversation = nativeId } = {}) => {
    const metadata = Buffer.concat([
      field(4, Buffer.concat([field(1, id), field(2, name)])),
      field(20, field(4, conversation)),
    ])
    const body = field(140, field(2, field(1, result)))
    db.prepare('INSERT INTO steps VALUES (132, 0, ?, ?, ?, ?)').run(error ? 7 : 3, metadata, error ? field(2, error) : null, body)
  }
  append('call_12', 'read_file', 'Showing lines 1-1 of 1\nfile contains fixture-secret')
  append('call_123', 'read_file', 'Different same-prefix call')
  append('call_12', 'read_file', 'Other trajectory output', { conversation: otherId })
  append('call_13', 'run_command', 'Unneeded native output')
  append('call_14', 'mcp_godbot_browser_open', '', { error: 'Browser requires an active environment' })
  append('call_15', 'mcp_godbot_request_secret', 'unredacted native secret')
  db.close()

  const history = new ExecutionHistory(rt, { readAntigravity: (binding, row) => readAntigravityToolResult(binding, row, rt.home) })
  t.after(() => history.close())
  const part = { botId: 'worker', sessionId: 'part', turn: 2 }
  const record = (id, name, detail) => history.record('part', {
    type: 'tool', id, name, status: 'completed', input: { fixture: true }, ...detail,
  }, 2)
  record('call_12', 'read_file')
  record('call_13', 'run_command', { output: { stdout: 'Reported over ACP' } })
  record('call_14', 'mcp_godbot_browser_open', { status: 'failed' })
  record('call_15', 'mcp_godbot_request_secret')
  assert.equal((await history.read(part)).events[0].output, undefined)
  const detail = async id => (await history.read({ ...part, toolId: id })).events[0]
  assert.match((await detail('call_12')).output, /file contains \[redacted\]/u)
  assert.deepEqual((await detail('call_13')).output, { stdout: 'Reported over ACP' })
  assert.equal((await detail('call_14')).error, 'Browser requires an active environment')
  assert.equal((await detail('call_15')).output, undefined)
  await assert.rejects(history.read({ ...part, botId: 'other', toolId: 'call_12' }), /私聊/)
  assert.equal(readAntigravityToolResult({ ...binding, cliSessionId: '../other' }, (await detail('call_12')), rt.home), undefined)
})
