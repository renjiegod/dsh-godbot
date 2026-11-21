import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { openDsh } from '../fixtures/member-dsh.js'

async function harness() {
  const cwd = await realpath(tmpdir())
  const callbacks = new Map(), tools = new Map(), sessions = new Map()
  const events = [], teamCalls = []
  let agent, turn = 0, idle
  function emit(name, ...args) { return Promise.all((callbacks.get(name) || []).map(listener => listener(...args))) }
  function claim(message) { void emit('agent/inbox/claimed', { agent, turn, message }) }
  function end(kind = 'completed') {
    if (agent.status !== 'running') return
    void emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind } } })
    agent.status = 'idle'
    idle.resolve()
  }
  const ctx = {
    llm: { async resolveCallConfig(route) { assert.equal(typeof route.model, 'string') } },
    agentDefaultModel: { currentSelection: () => ctx.defaultRoute },
    defaultRoute: { provider: 'default', model: 'one', reasoningEffort: 'light' },
    on(name, fn) {
      callbacks.set(name, [...(callbacks.get(name) || []), fn])
      return () => callbacks.set(name, callbacks.get(name).filter(listener => listener !== fn))
    },
    sessionController: {
      async create({ sessionId, cwd }) {
        let route
        agent = { id: sessionId, session: { header: { cwd } }, status: 'idle',
          model: { current: () => route, select: value => { route = { ...value } } },
          inbox: { nextStep: [], nextTurn: [], remove(id) {
            this.nextStep = this.nextStep.filter(message => message.id !== id)
            this.nextTurn = this.nextTurn.filter(message => message.id !== id)
          } },
          ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } },
          steer: claim, cancel: () => end('aborted'), whenIdle: () => idle.promise,
        }
        sessions.set(sessionId, agent)
        return { sessionId }
      },
      async resolveAgent(id) { return sessions.has(id) ? { agent: sessions.get(id) } : { error: new Error('Missing DSH session') } },
      async prompt(request) {
        agent.status = 'running'
        turn++
        idle = Promise.withResolvers()
        claim({ source: { kind: 'user', rpcId: request.requestId } })
        return { accepted: true }
      },
      cancel: () => end('aborted'),
    },
  }
  const open = (memberId = 'A', resumeId, config) => openDsh(ctx, {
    memberId, cwd, resumeId, config, onEvent: event => events.push(event),
  }, (...args) => { teamCalls.push(args); return {} })
  return { open, end, emit, claim, tools, events, teamCalls, ctx, get agent() { return agent }, get turn() { return turn } }
}

test('changing only reasoning updates the same native session and following defaults samples each new turn', async () => {
  const h = await harness()
  const route = { provider: 'one', model: 'model', reasoningEffort: 'deep' }
  const first = await h.open('A', undefined, route)
  assert.deepEqual(h.agent.model.current(), route)
  await first.close()
  const reset = await h.open('A', first.nativeId, { ...route, reasoningEffort: null })
  assert.deepEqual(h.agent.model.current(), { provider: 'one', model: 'model' })
  await reset.close()
  const inherited = await h.open('A', first.nativeId, { followProfileDefault: true })
  assert.deepEqual(h.agent.model.current(), h.ctx.defaultRoute)
  h.ctx.defaultRoute = { provider: 'next', model: 'profile-new', reasoningEffort: 'heavy' }
  await inherited.start({ turnId: 'new-default', text: 'Go' })
  assert.deepEqual(h.agent.model.current(), h.ctx.defaultRoute)
  assert.equal(inherited.nativeId, first.nativeId)
  h.end()
  await inherited.close()
})

test('native DSH input stays on its turn, streams text once and resumes the same owned session', async () => {
  const h = await harness(), driver = await h.open()
  await driver.start({ turnId: 'first', text: 'Start' })
  await driver.steer({ turnId: 'first', text: 'Change', commandId: 'edit' })
  assert.deepEqual(h.events.map(e => e.type), ['started'])
  const stream = frame => h.emit('agent/assistant-stream', { agent: h.agent, frame })
  await stream({ type: 'start', turn: h.turn, attemptId: 'one' })
  await stream({ type: 'chunk', attemptId: 'one', chunk: { type: 'text-delta', text: 'OK' } })
  await h.emit('session/event', h.agent.session, { type: 'assistant/message', data: {
    turn: h.turn, message: { content: [{ type: 'text', text: 'OK' }] },
  } })
  await h.emit('session/event', h.agent.session, { type: 'tool/call', data: {
    turn: h.turn, callId: 'c', name: 'read', arguments: '{"path":"SKILL.md"}',
  } })
  await h.emit('session/event', h.agent.session, { type: 'tool/result', data: {
    turn: h.turn, message: { toolCallId: 'c', content: [{ type: 'text', text: 'Skill instructions' }] },
  } })
  assert.deepEqual(h.events.filter(e => e.type === 'text').map(e => e.text), ['OK'])
  assert.deepEqual(h.events.filter(e => e.type === 'tool').map(({ toolId, status, input, output }) => [toolId, status, input, output]), [
    ['c', 'running', '{"path":"SKILL.md"}', undefined],
    ['c', 'completed', undefined, 'Skill instructions'],
  ])
  h.agent.inbox.nextStep.push({ id: 'ours', source: { rpcId: 'godbot/edit' } }, { id: 'theirs', source: { rpcId: 'interactive' } })
  await driver.interrupt({ turnId: 'first' })
  assert.deepEqual(h.agent.inbox.nextStep.map(item => item.id), ['theirs'])
  await assert.rejects(driver.steer({ turnId: 'first', text: 'Stale' }), /no longer active/)
  assert.equal(h.events.at(-1).status, 'interrupted')
  await driver.close()
  assert.equal(h.tools.size, 0)
  const resumed = await h.open('A', driver.nativeId)
  assert.equal(resumed.nativeId, driver.nativeId)
  await assert.rejects(h.open('B', driver.nativeId), /another member/)
  await resumed.close()
})

test('native DSH shows shell exit codes and keeps secret tool receipts private', async () => {
  const h = await harness(), driver = await h.open()
  await driver.start({ turnId: 'first', text: 'Start' })
  const emit = (type, data) => h.emit('session/event', h.agent.session, { type, data: { turn: h.turn, ...data } })
  const output = '(no output)\n[exit code: 128]'
  await emit('tool/ptc-dispatch-start', { callId: 'parent', subCallId: 'bash', name: 'bash', arguments: { command: 'exit 128' } })
  await emit('tool/ptc-dispatch', { callId: 'parent', subCallId: 'bash', name: 'bash', isError: false, content: [{ type: 'text', text: output }] })
  await emit('tool/call', { callId: 'secret', name: 'request_secret', arguments: '{"sensitive":"input"}' })
  await emit('tool/result', { message: { toolCallId: 'secret', content: [{ type: 'text', text: 'sensitive result' }] } })
  assert.deepEqual(h.events.filter(e => e.type === 'tool').map(({ status, input, output, exitCode }) => [status, input, output, exitCode]), [
    ['running', '{"command":"exit 128"}', undefined, undefined],
    ['failed', undefined, output, 128],
    ['running', undefined, undefined, undefined],
    ['completed', undefined, undefined, undefined],
  ])
  h.end()
  assert.equal(h.events.at(-1).status, 'completed')
  await driver.close()
})

test('native tools and human answers bind to the exact member, turn and request', async () => {
  const h = await harness(), driver = await h.open()
  await driver.start({ turnId: 'first', text: 'Start' })
  const tool = h.tools.get('godbot_list_members')
  const signal = new AbortController().signal
  assert.throws(() => tool.execute({}, { agent: { id: h.agent.id }, signal }), /does not own/)
  await tool.execute({}, { agent: h.agent, signal, callId: 'native-call-1' })
  assert.deepEqual(h.teamCalls, [['A','list_members',{},'native-call-1']])
  const unrelated = await h.emit('approval/request', { agent: {}, toolName: 'read' }, () => 'delegated')
  assert.deepEqual(unrelated, ['delegated'])
  const permission = h.emit('approval/request', { agent: h.agent, toolName: 'write', reason: 'write file' })
  const permissionId = h.events.at(-1).requestId
  await assert.rejects(driver.respond({ requestId: permissionId, decision: 'always' }), /allow or deny/)
  await driver.respond({ requestId: permissionId, decision: 'deny' })
  assert.deepEqual(await permission, ['rejected'])
  await assert.rejects(driver.respond({ requestId: permissionId, decision: 'allow' }), /already ended/)
  const answer = h.emit('user-questions/request', { agent: h.agent, questions: [
    { id: 'color', question: 'Which color?', options: [{ label: 'Blue' }] },
    { id: 'name', question: 'What name?' },
  ] })
  await driver.respond({ requestId: h.events.at(-1).requestId, answer: 'Blue' })
  await driver.respond({ requestId: h.events.at(-1).requestId, answer: 'Sparrow' })
  assert.deepEqual(await answer, [{ answers: [
    { id: 'color', selected: ['Blue'] }, { id: 'name', selected: [], custom: 'Sparrow' },
  ] }])
  h.claim({ source: { kind: 'user', rpcId: 'outside-godbot' } })
  assert.throws(() => tool.execute({}, { agent: h.agent, signal }), /does not own/)
  h.end()
  await driver.close()
})
