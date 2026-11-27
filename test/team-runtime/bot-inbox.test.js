import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { install } from '../../src/host/team-runtime/core/inbox.js'
import { SOURCE_KIND } from '../../src/host/team-runtime/core/constants.js'

test('an accepted delivery retries recovery when preparing its reply fails', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const args = {
    exchangeId: 'request', role: 'request', fromId: 'sender', toId: 'recipient',
    fromPart: 'sender', sessionId: 'recipient', text: 'Check inventory',
  }
  const row = {
    id: args.exchangeId, conversation: 'recipient', sequence: 1, args,
    state: 'accepted', acceptedAt: 900, attempt: { token: 'input', sessionId: 'recipient', turn: 1 },
  }
  const source = { kind: SOURCE_KIND, exchangeId: args.exchangeId, inboxAttempt: row.attempt.token, senderPart: 'sender' }
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Inventory checked' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const bots = { sender: { id: 'sender' }, recipient: { id: 'recipient' } }
  const warnings = []
  let recoveries = 0
  const rt = {
    state: { botInbox: { [row.id]: row } }, live: new Map(),
    ctx: { on() {}, effect: effect => t.after(effect()), get: () => new Map() },
    own: (table, key) => Object.hasOwn(table, key) ? table[key] : undefined,
    load: async () => {}, save: async () => {}, readOnly: () => undefined,
    warn: (...args) => warnings.push(args),
    chatOf: id => id, botOf: id => bots[id], closeWork() {}, exchangesOf: () => [],
    isBotSession: id => Object.hasOwn(bots, id), resolveAgent: async () => ({ status: 'running' }),
    async *eventsBackwards() { yield* events.toReversed() },
    relayMessage: () => ({ source }),
    async finishRecoveredInbox(sessionId, target, text) {
      if (++recoveries === 1) throw new Error('Reply attachment store is temporarily unavailable')
      await rt.inboxReply(row.id, sessionId, target, text)
    },
  }
  install(rt)
  await rt.bootBotInbox()
  const advance = async ms => {
    t.mock.timers.tick(ms)
    await new Promise(resolve => setImmediate(resolve))
  }
  await advance(0)
  assert.equal(recoveries, 1)
  assert.equal(warnings.length, 1)
  assert.equal(row.state, 'accepted')
  await advance(5000)
  assert.equal(recoveries, 2)
  assert.equal(row.state, 'replied')
  await advance(30_000)
  assert.equal(recoveries, 2)
  const replies = rt.inboxExchanges('sender', 'recipient').filter(item => item.replyTo === row.id)
  assert.deepEqual(replies.map(item => item.text), ['Inventory checked'])
})

test('a claim rejected before engine acceptance keeps its position and merges unread updates', async t => {
  const handlers = new Map()
  const bots = { sender: { id: 'sender' }, recipient: { id: 'recipient' } }
  const inputs = []
  const agent = {
    id: 'recipient', status: 'running',
    model: { current: () => ({ provider: 'fixture', model: 'model' }) },
    followup(message) { inputs.push(message) },
  }
  const state = { bots }
  const rt = {
    state, live: new Map(), chatOwners: new Map([['recipient', 'recipient']]),
    ctx: {
      on: (name, listener) => handlers.set(name, listener),
      effect: effect => t.after(effect()),
      get: name => name === 'llm' ? { prepareCall: async () => {} } : { get: () => agent },
    },
    load: async () => {}, save: async () => {}, readOnly: () => undefined,
    warn: (...args) => assert.fail(args.join(' ')),
    own: (table, key) => Object.hasOwn(table, key) ? table[key] : undefined,
    selfOf: id => id, botOf: id => bots[id], chatOf: id => id,
    isBotSession: id => id in bots, sameWork: () => true,
    resolveAgent: async () => agent, ensureCapabilities: async () => {},
    relayMessage: ({ exchangeId, inboxAttempt, text }) => ({
      id: inboxAttempt, source: { kind: SOURCE_KIND, exchangeId, inboxAttempt },
      content: [{ type: 'text', text }],
    }),
  }
  install(rt)
  const enqueue = (id, text, previous) => rt.enqueueBotDelivery({
    exchangeId: id, role: 'request', fromId: 'sender', toId: 'recipient',
    fromPart: 'sender', sessionId: 'recipient', text,
  }, { previous })
  const first = await enqueue('first', 'OPS-123 Verify the manifest')
  const second = await enqueue('second', 'OPS-124 Count stock')
  const rows = () => rt.inboxForChat('recipient', 'recipient')
  assert.deepEqual(rows().map(row => row.sequence), [1, 2])

  const idle = () => {
    agent.status = 'idle'
    handlers.get('agent/status')({ agent, status: 'idle' })
  }
  async function waitForInput(count) {
    for (let ticks = 0; ticks < 100 && inputs.length < count; ticks++) await delay(5)
    assert.equal(inputs.length, count)
  }
  idle()
  await waitForInput(1)
  agent.status = 'running'
  rt.live.set('recipient', { turn: 1 })
  handlers.get('agent/inbox/claimed')({ agent, message: inputs[0], turn: 1 })
  handlers.get('session/event')({ id: 'recipient' }, {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'UNSUPPORTED_REASONING_EFFORT' } } },
  })
  assert.equal(rows()[0].state, 'blocked')
  assert.equal(rows()[0].reason, 'UNSUPPORTED_REASONING_EFFORT')
  assert.equal(rows()[1].state, 'queued')
  assert.equal(rt.inboxCanAnswer(first.id), false)

  const supplement = {
    fromId: 'sender', fromPart: 'sender', toId: 'recipient', toUser: false,
    text: 'OPS-123 Add the crate count',
  }
  assert.equal(rt.unreadBotDelivery('recipient', { ...supplement, initiator: { kind: 'schedule', readOnly: true } }), undefined)
  const previous = rt.unreadBotDelivery('recipient', supplement)
  const merged = await enqueue('first', 'OPS-123 Verify the manifest and crate count', previous)
  assert.equal(merged.id, first.id)
  assert.equal(merged.sequence, first.sequence)
  assert.equal(rows()[1].id, second.id)
  idle()
  await waitForInput(2)
  assert.equal(inputs[1].source.exchangeId, first.id)
  assert.match(inputs[1].content[0].text, /crate count/u)
  assert.notEqual(inputs[1].source.inboxAttempt, inputs[0].source.inboxAttempt)
})
