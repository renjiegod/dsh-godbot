import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { claimTeamTerminal } from '../../src/host/team-runtime/terminal-lease.js'
import { WorkspaceAgentAdapter } from '../../src/host/team-runtime/local-agents.js'

async function fixture(route = 'local-codex-cli') {
  const part = randomUUID(), id = randomUUID(), cwd = await realpath(tmpdir())
  const bot = { id: 'b', model: route + '/model-1', effort: 'high' }
  const record = { cliSessionId: id, route, cwd, handedId: 'last-chat-message' }
  const agent = { status: 'idle', session: { header: { cwd } }, inbox: { nextStep: [], nextTurn: [] } }
  const rt = {
    botOf: key => key === bot.id && bot, chatOf: () => part, groupOwners: new Map(), readOnly: () => undefined,
    resolveAgent: async () => agent, engineOfBot: () => route, workDirOf: () => cwd, save: async () => {},
    state: { localAgents: { sessions: { [part]: record } } },
  }
  const adapter = new WorkspaceAgentAdapter({ record: key => rt.state.localAgents.sessions[key],
    presetFor: () => bot.permission ?? 'workspace-write' })
  return { rt, adapter, agent, record, part, bot, claim: () => claimTeamTerminal(rt, adapter, bot.id, part) }
}

test('team PTY claims only the current part and preserves native identity across release and reattach', async () => {
  const { rt, adapter, part, record, bot, claim } = await fixture()
  await assert.rejects(claimTeamTerminal(rt, adapter, bot.id, 'other'), /当前/)
  const result = await claim()
  assert.equal(result.sessionId, record.cliSessionId)
  assert.equal(result.model, 'model-1')
  assert.equal(result.effort, 'high')
  assert.equal(record.terminalSessionId, record.cliSessionId)
  assert.equal(record.handedId, 'last-chat-message')
  await assert.rejects(claim(), /终端中使用/)
  await assert.rejects(adapter.stream({ sessionId: part }).next(), /终端中使用/)
  await assert.rejects(adapter.maintain(part, undefined, () => {}), /终端中使用/)
  let delivered = 0
  const held = adapter.terminalLeases.waitForChat(part).then(() => delivered++)
  await Promise.resolve()
  assert.equal(delivered, 0)
  result.release()
  await held
  assert.equal(delivered, 1)
  const next = await claim()
  result.release()
  assert.throws(() => adapter.terminalLeases.enter(part), /终端中使用/)
  const disposed = adapter.terminalLeases.dispose()
  assert.ok(next.signal.aborted)
  next.release()
  await disposed
})

test('team terminal handoff honors the effective session preset after hydration', async () => {
  for (const route of ['local-antigravity', 'local-claude-code', 'local-codex-cli']) {
    const { rt, adapter, agent, record, part, claim } = await fixture(route)
    let effective = 'workspace-write'
    adapter.deps.presetFor = (id, options) => {
      assert.equal(id, part)
      assert.deepEqual(options, { terminal: true })
      return effective
    }
    rt.resolveAgent = async () => {
      effective = 'read-only'
      return agent
    }
    await assert.rejects(claim(), /只读/)
    assert.equal(record.terminalSessionId, undefined)

    rt.resolveAgent = async () => agent
    effective = 'custom'
    await assert.rejects(claim(), /无法维持/)
    for (const value of ['workspace-write', 'danger-full-access']) {
      effective = value
      const lease = await claim()
      assert.equal(lease.permissionPreset, value)
      assert.equal(lease.agent, route)
      lease.release()
    }
  }
})

test('native chat reads only redacted messages from the current leased CLI binding', async () => {
  const { rt, part, claim, record } = await fixture('local-codex-cli')
  const read = Promise.withResolvers()
  rt.executionHistory = { nativeTurns(key) { assert.equal(key, part); return read.promise } }
  rt.redactSecrets = text => text.replaceAll('password', '[redacted]')
  const lease = await claim()
  const records = lease.readHistory()
  read.resolve([{ nativeTurnId: 'native-1', events: [
    { type: 'input', seq: 1, text: 'hello' }, { type: 'tool', seq: 2, output: 'password' },
    { type: 'text', seq: 3, text: 'your password' },
  ] }])
  assert.deepEqual(await records, { source: 'native', messages: [
    { id: 'native-1/1', role: 'user', text: 'hello' }, { id: 'native-1/3', role: 'assistant', text: 'your [redacted]' },
  ] })
  const changed = lease.readHistory()
  record.cliSessionId = randomUUID()
  await assert.rejects(changed, /已切换/)
  lease.release()
  await assert.rejects(lease.readHistory(), /已切换/)
})

test('native chat uses the exact Bot history for ACP and sandbox accounts and bounds the response', async () => {
  for (const route of ['local-antigravity', 'local-sandbox-claude-test']) {
    const { rt, claim, part } = await fixture(route)
    rt.validateSandboxPart = () => {}
    rt.executionHistory = { nativeTurns() { assert.fail('must not inspect local provider history') } }
    rt.partLines = async function* (key) {
      assert.equal(key, part)
      yield { who: 'you', seq: 102, text: 'You: latest answer' }
      yield { who: 'user', seq: 101, text: 'User: latest request' }
      yield { who: 'bot', seq: 100, text: 'bot relay' }
      for (let seq = 99; seq >= 0; --seq) yield { who: 'user', seq, text: 'x'.repeat(25_000) }
    }
    const lease = await claim()
    const { source, messages } = await lease.readHistory()
    assert.equal(source, 'bot')
    assert.deepEqual(messages.slice(-2), [
      { id: '101', role: 'user', text: 'latest request' }, { id: '102', role: 'assistant', text: 'latest answer' },
    ])
    assert.ok(messages.length < 80)
    assert.equal(messages.some(row => row.id === '100'), false)
    assert.equal(messages.reduce((size, row) => size + row.text.length, 0), 64 * 1024)
    assert.ok(messages[0].text.endsWith('…'))
    lease.release()
  }
})

test('handback during Bot history lookup discards late data even when the next lease has the same native ID', async () => {
  const { rt, claim } = await fixture('local-claude-code')
  const started = Promise.withResolvers(), done = Promise.withResolvers()
  rt.executionHistory = { nativeTurns: async () => [] }
  rt.partLines = async function* () { started.resolve(); await done.promise; yield { who: 'user', seq: 2, text: 'User: late' } }
  const lease = await claim()
  const history = lease.readHistory()
  await started.promise
  lease.release()
  const next = await claim()
  done.resolve()
  await assert.rejects(history, /已切换/)
  next.release()
})

test('a session policy change revokes an active team terminal and invalidates its cached exit', async () => {
  const { rt, adapter, part, claim } = await fixture('local-claude-code')
  let effective = 'danger-full-access'
  let observe
  adapter.deps.presetFor = () => effective
  rt.ctx = { on(event, handler) {
    assert.equal(event, 'session/event')
    observe = handler
    return () => { observe = undefined }
  } }
  const lease = await claim()
  assert.equal(lease.stillCurrent(), true)
  effective = 'workspace-write'
  observe({ id: 'other' }, { type: 'permission/preset' })
  assert.equal(lease.signal.aborted, false)
  observe({ id: part }, { type: 'approval/policy' })
  assert.equal(lease.signal.aborted, true)
  assert.equal(lease.stillCurrent(), false)
  lease.release()
  assert.equal(observe, undefined)
})

test('turn admission and terminal reservation are atomic during asynchronous startup and failure', async () => {
  const { rt, adapter, part, claim } = await fixture()
  const writing = adapter.terminalLeases.enter(part)
  await assert.rejects(claim(), /当前任务/)
  writing()
  const wait = Promise.withResolvers()
  rt.resolveAgent = () => wait.promise
  const opening = claim()
  assert.throws(() => adapter.terminalLeases.enter(part), /终端中使用/)
  await assert.rejects(claim(), /终端中使用/)
  wait.reject(new Error('test failure'))
  await assert.rejects(opening, /test failure/)
  adapter.terminalLeases.enter(part)()
})

test('a changed Bot binding revokes the terminal and retains exclusivity until process exit', async () => {
  const { rt, part, adapter, claim } = await fixture()
  let change
  rt.onSaved = listener => { change = listener; return () => { change = undefined } }
  const lease = await claim()
  rt.chatOf = () => 'another-part'
  change()
  assert.equal(lease.signal.aborted, true)
  assert.throws(() => adapter.terminalLeases.enter(part), /终端中使用/)
  lease.release()
  assert.equal(change, undefined)
  adapter.terminalLeases.enter(part)()
})

test('pending work, approvals, missing or shared CLI ids and a moved workspace prevent takeover', async () => {
  for (const [change, error] of [
    [({ agent }) => { agent.inbox.nextTurn = [{}] }, /当前任务/],
    [({ rt }) => { rt.waitsForApproval = () => true }, /当前任务/],
    [({ rt }) => { rt.hasSubagents = () => true }, /当前任务/],
    [({ agent }) => { agent.status = 'running' }, /当前任务/],
    [({ record }) => { delete record.cliSessionId }, /先在聊天/],
    [({ record }) => { record.route = 'local-claude-code' }, /切换/],
    [({ record }) => { record.accountProfileId = 'wrong-account' }, /沙箱账号/],
    [({ bot }) => { bot.permission = 'read-only' }, /只读/],
    [({ rt, record }) => { rt.state.localAgents.sessions.other = { ...record } }, /其他聊天/],
    [({ rt }) => { rt.workDirOf = () => process.cwd() }, /目录/],
  ]) {
    const f = await fixture()
    change(f)
    await assert.rejects(f.claim(), error)
    assert.equal(f.adapter.terminalLeases.claims.size, 0)
  }
})

test('sandbox workspace route tags cannot give two Bots concurrent ownership of one account thread', async () => {
  const { rt, record, claim } = await fixture('local-sandbox-claude-test')
  rt.validateSandboxPart = () => {}
  rt.state.localAgents.sessions.other = { ...record, route: 'local-sandbox-claude-test_w_0123456789abcdef' }
  await assert.rejects(claim(), /其他聊天/)
  rt.state.localAgents.sessions.other.route = 'local-sandbox-claude-other'
  const lease = await claim()
  lease.release()
})

test('native detach waits for thread/unsubscribe, and a pending approval is never cancelled', async () => {
  const f = await fixture()
  const calls = [], done = Promise.withResolvers(), started = Promise.withResolvers()
  const engine = { peer: { request(method, params) { calls.push([method, params]); started.resolve(); return done.promise } } }
  const live = { sessionId: f.part, route: f.record.route, cliSessionId: f.record.cliSessionId, queue: [],
    waiters: [], pending: new Map([['approval', {}]]), state: 'idle', spec: { kind: 'codex' }, engineSession: {}, engine }
  f.adapter.live.set(f.part, live)
  await assert.rejects(f.claim(), /当前任务/)
  assert.deepEqual(calls, [])
  live.pending.clear()
  const opening = f.claim()
  await started.promise
  assert.deepEqual(calls, [['thread/unsubscribe', { threadId: f.record.cliSessionId }]])
  assert.throws(() => f.adapter.terminalLeases.enter(f.part), /终端中使用/)
  done.resolve({})
  const result = await opening
  result.release()
  assert.equal(f.adapter.live.has(f.part), false)
})
