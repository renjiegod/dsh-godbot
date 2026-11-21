import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { install, WorkspaceAcpEngine, WorkspaceAgentAdapter, WorkspaceCodexEngine } from '../../src/host/team-runtime/local-agents.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

test('ACP Bot approvals follow the effective DSH session permissions', async t => {
  const session = { id: 'bot-part' }
  const bot = { id: 'bot', model: 'local-antigravity/default' }
  let preset
  let approvalOutcome
  let fullAccessApproval
  let actualSandbox
  const room = { id: 'room' }
  const approval = fakeApproval(() => approvalOutcome)
  const ctx = fakeContext({ services: {
    approval,
    sessions: new Map([[session.id, session]]),
    sandboxPolicy: { resolve: () => ({ mode: actualSandbox }) },
    permissionPresets: {
      current(current) {
        assert.equal(current, session)
        return preset
      },
      resolve(name) {
        if (name === 'workspace-write') return { sandbox: name, approval: 'ask' }
        if (name !== 'danger-full-access' || fullAccessApproval === null) throw new Error('Unknown preset')
        return { sandbox: 'danger-full-access', approval: fullAccessApproval }
      },
    },
  } })
  const rt = { ctx, state: { bots: { [bot.id]: bot } }, groupOwners: new Map(),
    selfOf: () => bot.id, botOf: () => bot, roomOf: id => id === room.id ? room : undefined }
  install(rt)
  t.after(() => ctx.dispose())
  const [{ adapter }] = ctx.adapters
  const approvalTool = rt.localAgentTools.find(tool => tool.name === 'approve_agent_action')

  await t.test('Agy full access uses the normal native mode instead of the sandboxed Auto mode', () => {
    const { modes } = adapter.engine('local-antigravity').engine
    assert.deepEqual(modes['danger-full-access'], ['default'])
    assert.deepEqual(modes['workspace-write'], ['accept-edits'])
    assert.deepEqual(modes['read-only'], ['default'])
  })

  for (const route of ['local-claude-code', 'local-codex-cli', 'local-antigravity', 'local-cursor-cli', 'local-gemini-cli', 'local-opencode']) {
    await t.test(`${route} uses the live session policy for chat and terminal`, () => {
      bot.model = `${route}/default`
      delete bot.permission
      fullAccessApproval = 'never'
      preset = 'danger-full-access'
      assert.equal(adapter.deps.presetFor(session.id), 'danger-full-access')
      assert.equal(adapter.deps.presetFor(session.id, { terminal: true }), 'danger-full-access')
      preset = 'custom'
      assert.equal(adapter.deps.presetFor(session.id), 'workspace-write')
      assert.equal(adapter.deps.presetFor(session.id, { terminal: true }), 'custom')
      actualSandbox = 'read-only'
      assert.equal(adapter.deps.presetFor(session.id), 'read-only')
      assert.equal(adapter.deps.presetFor(session.id, { terminal: true }), 'read-only')
      actualSandbox = undefined
      preset = 'workspace-write'
      assert.equal(adapter.deps.presetFor(session.id, { terminal: true }), 'workspace-write')
      rt.groupOwners.set(session.id, { roomId: room.id })
      room.permission = 'read-only'
      preset = 'danger-full-access'
      assert.equal(adapter.deps.presetFor(session.id), 'read-only')
      rt.groupOwners.delete(session.id)
    })
  }

  await t.test('tightening permission closes a running full-access native session', async () => {
    bot.model = 'local-codex-cli/default'
    preset = 'danger-full-access'
    const calls = []
    const live = { sessionId: session.id, preset, state: 'running', queue: [], pending: new Map(), waiters: [],
      engineSession: {}, engine: { cancel: () => calls.push('cancel'), forget: () => calls.push('forget') } }
    adapter.live.set(session.id, live)
    const changed = ctx.listeners.get('session/event').at(-1)
    changed(session, { type: 'permission/preset' })
    await Promise.resolve()
    assert.equal(adapter.live.get(session.id), live)
    preset = 'workspace-write'
    changed(session, { type: 'sandbox/mode' })
    changed(session, { type: 'approval/policy' })
    await Promise.resolve()
    assert.equal(adapter.live.has(session.id), false)
    assert.deepEqual(calls, ['cancel', 'forget'])
  })

  for (const sample of [
    { name: 'inherited full access allows the command without a DSH approval request', preset: 'danger-full-access', optionId: 'once' },
    { name: 'an inherited generic ACP route can allow once under full access', route: 'local-cursor-cli', preset: 'danger-full-access', optionId: 'once' },
    { name: 'inherited workspace access asks for approval', preset: 'workspace-write', outcome: 'allowed-once', optionId: 'once' },
    { name: 'effective workspace access takes precedence over saved full access', preset: 'workspace-write', saved: 'danger-full-access', outcome: 'rejected' },
    { name: 'a narrower saved workspace preset blocks automatic approval while applying', preset: 'danger-full-access', saved: 'workspace-write', outcome: 'rejected' },
    { name: 'custom permissions do not fall back to saved full access', preset: 'custom', saved: 'danger-full-access', outcome: 'rejected' },
    { name: 'auto review does not fall back to saved full access', preset: 'auto', saved: 'danger-full-access', outcome: 'rejected' },
    { name: 'a full access name alone does not suppress configured approvals', preset: 'danger-full-access', fullAccessApproval: 'ask', outcome: 'allowed-once', optionId: 'once' },
    { name: 'an unresolved full access preset does not auto-allow', preset: 'danger-full-access', saved: 'danger-full-access', fullAccessApproval: null, outcome: 'rejected' },
  ]) {
    await t.test(sample.name, async () => {
      bot.model = `${sample.route ?? 'local-antigravity'}/default`
      preset = sample.preset
      bot.permission = sample.saved
      approvalOutcome = sample.outcome
      fullAccessApproval = sample.fullAccessApproval === undefined ? 'never' : sample.fullAccessApproval
      const requestCount = approval.requests.length
      const engine = new WorkspaceAcpEngine('local-antigravity', {}, {})
      const native = engine.sessionFor(session.id)
      native.acpSessionId = 'native-id'
      const events = []
      native.push = event => events.push(event)
      const decision = engine.onRequest('session/request_permission', {
        sessionId: native.acpSessionId, toolCall: { toolCallId: 'git', kind: 'execute', title: 'git log -1' },
        options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }],
      })
      events.push({ type: 'done' })
      const live = { sessionId: session.id, pending: new Map(), queue: [], next: async () => events.shift() }
      const chunks = await Array.fromAsync(adapter.drain(live, {}))
      const call = chunks.find(chunk => chunk.type === 'tool-call-delta')
      if (sample.outcome === undefined) {
        assert.equal(call, undefined)
        assert.equal(chunks.at(-1).reason.kind, 'stop')
        assert.equal(approval.requests.length, requestCount)
      } else {
        assert.equal(call?.name, 'approve_agent_action')
        assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
        const response = await approvalTool.execute(JSON.parse(call.argumentsDelta), { name: call.name, callId: call.id, agent: { session } })
        assert.equal(approval.requests.length, requestCount + 1)
        assert.equal(approval.requests.at(-1).agent.session, session)
        live.pending.get(call.id).resolve({ text: response })
      }
      assert.deepEqual(await decision, { outcome: sample.optionId
        ? { outcome: 'selected', optionId: sample.optionId }
        : { outcome: 'cancelled' } })
    })
  }
})

for (const cwdPerProcess of [false, true]) {
  test(`ACP Bot tool activity survives partial updates (${cwdPerProcess ? 'workspace worker' : 'shared process'})`, async () => {
    const engine = new WorkspaceAcpEngine('acp-fixture', { cwdPerProcess }, {})
    const worker = cwdPerProcess ? engine.spawnWorker(tmpdir()) : engine
    const session = worker.sessionFor('bot-part')
    session.acpSessionId = 'native-id'
    const notices = []
    session.push = event => notices.push(event)
    const update = (sessionUpdate, fields, sessionId = session.acpSessionId) =>
      worker.onNotice('session/update', { sessionId, update: { sessionUpdate, ...fields } })

    update('tool_call', { toolCallId: 'read', kind: 'read', status: 'pending', locations: [{ path: 'src/a.js' }] })
    update('tool_call_update', { toolCallId: 'read', status: 'in_progress' })
    update('tool_call_update', { toolCallId: 'read', status: 'completed', rawOutput: 'fixture text omitted from activity' })
    update('tool_call_update', { toolCallId: 'read', status: 'completed' })
    update('tool_call', { toolCallId: 'shell', kind: 'execute', title: 'npm test', rawInput: { command: 'npm test -- private-arg' } })
    update('tool_call', { toolCallId: 'connector', toolName: 'fixture_connector', status: 'completed' })
    update('tool_call_update', { toolCallId: 'other', status: 'failed' }, 'other-native-id')

    const permission = worker.onRequest('session/request_permission', {
      sessionId: session.acpSessionId, toolCall: { toolCallId: 'shell' }, options: [{ optionId: 'deny', kind: 'reject_once' }],
    })
    const pending = notices.pop()
    assert.equal(pending.type, 'permission')
    assert.match(pending.action, /npm test -- private-arg/)
    pending.reply('deny')
    assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'deny' } })
    update('tool_call_update', { toolCallId: 'shell', status: 'failed', rawOutput: 'fixture error omitted from activity' })

    assert.deepEqual(notices.filter(event => event.type === 'activity').map(event => event.text), [
      '▸ Read · src/a.js · 调用',
      '▸ Read · src/a.js · 完成',
      '▸ Shell · npm test · 调用',
      '▸ fixture_connector · 完成',
      '▸ Shell · npm test · 失败',
    ])
    const read = notices.map(event => event.trace).filter(trace => trace?.id === 'read')
    assert.deepEqual(read.map(trace => trace.status), ['pending', 'running', 'completed', 'completed'])
    assert.equal(read.at(-1).output, 'fixture text omitted from activity')
    assert.deepEqual(read.at(-1).locations, [{ path: 'src/a.js' }])
    const shell = notices.at(-1).trace
    assert.equal(shell.status, 'failed')
    assert.deepEqual(shell.input, { command: 'npm test -- private-arg' })
    assert.equal(shell.output, 'fixture error omitted from activity')
  })
}

test('ACP command results expose a nonzero process exit even when the agent completed the tool call', () => {
  const engine = new WorkspaceAcpEngine('acp-fixture', {}, {})
  const session = engine.sessionFor('part')
  session.acpSessionId = 'native-id'
  const notices = []
  session.push = event => notices.push(event)
  const update = (sessionUpdate, values) => engine.onNotice('session/update', {
    sessionId: session.acpSessionId, update: { sessionUpdate, toolCallId: 'call_127', ...values },
  })
  update('tool_call', { kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'fixture-browser --help' } })
  update('tool_call_update', { status: 'completed', rawOutput: { output: 'operation not permitted', exit_code: 127 } })
  update('tool_call_update', { status: 'completed' })
  assert.deepEqual(notices.map(notice => notice.trace.status), ['pending', 'failed', 'failed'])
  assert.equal(notices[1].trace.exitCode, 127)
  assert.equal(notices.filter(notice => notice.type === 'activity' && notice.trace.status === 'failed').length, 1)
})

test('Codex Bot records rich tool updates during its matching turn without streaming raw output into the model', async () => {
  const engine = new WorkspaceCodexEngine('codex-fixture', {}, {})
  const thread = engine.threadFor('bot-part')
  thread.threadId = 'native-thread'
  const events = []
  thread.push = event => events.push(event)
  const notice = (method, payload, turnId = 'turn-current') =>
    engine.onNotice(method, { threadId: thread.threadId, turnId, ...payload })

  const command = { id: 'command-1', type: 'commandExecution', command: 'npm test -- --reporter=tap', cwd: '/work' }
  notice('item/started', { item: command })
  notice('item/commandExecution/outputDelta', { itemId: command.id, delta: 'late previous output' }, 'turn-previous')
  notice('item/commandExecution/outputDelta', { itemId: command.id, delta: 'fixture test output' })
  notice('item/completed', { item: { ...command, status: 'failed', exitCode: 7, durationMs: 200, aggregatedOutput: 'fixture test output\nError' } })
  const changes = [{ path: 'test.js', kind: { type: 'update' }, diff: '+test()' }]
  notice('item/completed', { item: { type: 'fileChange', id: 'edit-1', changes, status: 'completed' } })
  notice('turn/completed', { turn: { id: 'turn-current', status: 'completed' } })

  const records = []
  const adapter = new WorkspaceAgentAdapter({ rt: { executionHistory: { record: (id, event) => records.push({ id, event }) } } })
  const live = { sessionId: 'bot-part', turnTag: 'turn-current', next: () => Promise.resolve(events.shift()), queue: [] }
  const chunks = []
  for await (const chunk of adapter.drain(live, {})) chunks.push(chunk)

  assert.ok(records.every(row => row.id === live.sessionId))
  assert.deepEqual(records.map(row => Object.fromEntries(Object.entries(row.event).filter(([, value]) => value !== undefined))), [
    { type: 'tool', id: command.id, name: 'Shell', status: 'running', input: command.command, cwd: '/work' },
    { type: 'tool', id: command.id, outputDelta: 'fixture test output' },
    { type: 'tool', id: command.id, name: 'Shell', status: 'failed', input: command.command, cwd: '/work', exitCode: 7, durationMs: 200, output: 'fixture test output\nError' },
    { type: 'tool', id: 'edit-1', name: 'Edit', status: 'completed', changes },
  ])
  const activity = chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  assert.match(activity, /▸ Shell · npm test · 调用/)
  assert.doesNotMatch(activity, /fixture test output|--reporter|late previous output/)
})

test('Codex Bot forwards assistant text deltas and only the unseen completion suffix', () => {
  const engine = new WorkspaceCodexEngine('codex-fixture', {}, {})
  const thread = engine.threadFor('bot-part')
  thread.threadId = 'native-thread'
  const events = []
  thread.push = event => events.push(event)
  const notice = (method, payload, turnId = 'turn-first') =>
    engine.onNotice(method, { threadId: thread.threadId, turnId, ...payload })

  const report = { id: 'report', type: 'agentMessage' }
  notice('item/started', { item: { ...report, text: '' } })
  notice('item/agentMessage/delta', { itemId: report.id, delta: 'First ' })
  assert.deepEqual(events, [{ type: 'text', text: 'First ', turnId: 'turn-first' }])
  notice('item/agentMessage/delta', { itemId: report.id, delta: 'pass' })
  notice('item/completed', { item: { ...report, text: 'First pass complete.' } })
  notice('item/completed', { item: { ...report, text: 'First pass complete.' } })
  notice('item/agentMessage/delta', { itemId: report.id, delta: 'ignored after completion' })

  notice('item/completed', { item: { ...report, id: 'older-agent', type: 'agent_message', text: ' Non-streaming output.' } })
  notice('turn/completed', { turn: { id: 'turn-first', status: 'completed' } })
  notice('item/completed', { item: { ...report, text: 'Second turn.' } }, 'turn-second')
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => [event.turnId, event.text]), [
    ['turn-first', 'First '],
    ['turn-first', 'pass'],
    ['turn-first', ' complete.'],
    ['turn-first', ' Non-streaming output.'],
    ['turn-second', 'Second turn.'],
  ])
})

test('Codex Bot leaves its verified godbot MCP receipts to DSH without hiding other MCP tool details', () => {
  const engine = new WorkspaceCodexEngine('codex-fixture', {}, {})
  const thread = engine.threadFor('bot-part')
  thread.threadId = 'native-thread'
  const events = []
  thread.push = event => events.push(event)
  const notice = (method, payload) => engine.onNotice(method, { threadId: thread.threadId, turnId: 'turn', ...payload })

  const tool = { type: 'mcpToolCall', id: 'bridge', server: 'godbot', tool: 'message_bot', arguments: { message: 'hello' } }
  notice('item/started', { item: tool })
  notice('item/mcpToolCall/progress', { itemId: tool.id, message: 'Waiting for DSH' })
  notice('item/completed', { item: { ...tool, status: 'completed', result: { content: [] } } })

  const direct = { ...tool, id: 'direct', server: 'independent', tool: 'fixture_fetch' }
  notice('item/started', { item: direct })
  notice('item/mcpToolCall/progress', { itemId: direct.id, message: 'Reading fixture' })
  notice('item/completed', { item: { ...direct, status: 'completed', result: { content: ['Fixture details'] } } })
  const unavailable = { ...tool, id: 'unavailable' }
  notice('item/started', { item: unavailable })
  notice('item/completed', { item: { ...unavailable, status: 'failed', result: null, error: { message: 'Loopback unavailable' } } })
  assert.deepEqual(events.slice(0, 2).map(event => event.text), ['▸ message_bot · 调用', '▸ message_bot · 完成'])
  const trace = events.map(event => event.trace).filter(Boolean)
  assert.deepEqual(trace.map(event => event.id), ['direct', 'direct', 'direct', 'unavailable'])
  assert.equal(trace[1].outputDelta, 'Reading fixture\n')
  assert.deepEqual(trace[2].output, { content: ['Fixture details'] })
  assert.deepEqual(trace[3].output, { message: 'Loopback unavailable' })
})
