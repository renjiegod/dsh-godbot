import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { install } from '../../src/host/team-runtime/core/inbox.js'
import { SOURCE_KIND } from '../../src/host/team-runtime/core/constants.js'

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
