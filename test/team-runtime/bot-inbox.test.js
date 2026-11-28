import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { install } from '../../src/host/team-runtime/core/inbox.js'
import { SOURCE_KIND } from '../../src/host/team-runtime/core/constants.js'

test('only the executing recipient records milestones on an accepted request', async () => {
  const info = { role: 'request', exchangeId: 'message' }
  const row = { id: 'message', state: 'accepted', attempt: { sessionId: 'part', turn: 3 },
    args: { role: 'request', fromId: 'sender', toId: 'worker', sessionId: 'part' } }
  const rt = {
    ctx: { on() {}, effect() {} }, state: { botInbox: { message: row } },
    own: (table, key) => table[key], readOnly: () => undefined, selfOf: () => 'worker',
    live: new Map([['part', { turn: 3, info }], ['other', { turn: 3, info }]]),
    save: async () => {}, redactSecrets: line => line.replace('fixture-key', '[hidden]'),
  }
  install(rt)
  assert.equal(await rt.recordInboxProgress('other', 'wrong conversation'), false)
  await assert.rejects(rt.recordInboxProgress('part', '  '), /Write a progress update/u)
  assert.equal(await rt.recordInboxProgress('part', 'Waiting for\nfixture-key', true), true)
  const saved = row.progress
  assert.equal(saved.text, 'Waiting for [hidden]')
  assert.equal(saved.blocked, true)
  assert.equal(row.state, 'accepted')
  assert.deepEqual(rt.inboxExchanges('sender', 'worker')[0].delivery.progress, saved)
  rt.save = async () => { throw new Error('disk unavailable') }
  await assert.rejects(rt.recordInboxProgress('part', 'replacement'), /disk unavailable/u)
  assert.equal(row.progress, saved)
  row.state = 'replied'
  assert.equal(await rt.recordInboxProgress('part', 'late result'), false)
})

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

test('an unaccepted delivery keeps its position on retry and a scoped stop preserves later work', async t => {
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

  agent.status = 'running'
  rt.live.set('recipient', { turn: 2 })
  handlers.get('agent/inbox/claimed')({ agent, message: inputs[1], turn: 2 })
  // Goal and work-board stops cancel just the turn and pass keepInbox to DSH.
  handlers.get('session/event')({ id: 'recipient' }, {
    type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.equal(rows()[0].state, 'stopped')
  assert.equal(rows()[1].state, 'queued')
  idle()
  await waitForInput(3)
  assert.equal(inputs[2].source.exchangeId, second.id)
  assert.equal(rt.stopBotInbox('recipient', 'recipient'), true)
  assert.equal(rows()[1].state, 'stopped')
})

test('a legacy accepted Codex request recovers only when both histories support it', async t => {
  for (const outcome of ['interrupted', 'completed', 'user-stop']) {
    await t.test(outcome, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
      const args = { role: 'request', exchangeId: 'request', fromId: 'sender', toId: 'recipient',
        fromPart: 'sender', sessionId: 'recipient', text: 'Original request' }
      const prior = { kind: SOURCE_KIND, exchangeId: args.exchangeId, inboxAttempt: 'old-attempt' }
      const blocked = { id: args.exchangeId, conversation: 'recipient', sequence: 1, args,
        acceptedAt: 500, state: 'blocked', reason: 'REPLY_UNKNOWN',
        attempt: { token: prior.inboxAttempt, sessionId: 'recipient', turn: 1, native: { turnId: 'native-1' } } }
      const reason = outcome === 'user-stop' ? { kind: 'aborted', reason: { kind: 'user' } } : {
        kind: 'error', error: { code: 'LOCAL_AGENT_INTERRUPTED', message: 'Godbot closed the native agent session before the turn finished.' },
      }
      const events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { source: prior } },
        { type: 'turn/end', data: { turn: 1, reason } },
      ]
      const messages = []
      const native = []
      const replies = []
      const bots = { sender: { id: 'sender' }, recipient: { id: 'recipient' } }
      const agent = { status: 'idle', model: { current: () => ({ provider: 'local-codex-cli', model: 'fixture' }) },
        followup: message => messages.push(message) }
      const rt = {
        state: { botInbox: { [blocked.id]: blocked } }, live: new Map(),
        ctx: { on() {}, effect: effect => t.after(effect()),
          get: name => name === 'llm' ? { prepareCall: async () => {} } : { get: () => agent } },
        own: (table, key) => Object.hasOwn(table, key) ? table[key] : undefined,
        load: async () => {}, save: async () => {}, readOnly: () => undefined,
        warn: (...args) => assert.fail(args.join(' ')),
        chatOf: id => id, botOf: id => bots[id], isBotSession: id => id in bots,
        closeWork() {}, dropWork() {}, exchangesOf: () => [],
        resolveAgent: async () => agent, ensureCapabilities: async () => {},
        async *eventsBackwards() { yield* events.toReversed() },
        relayMessage: ({ text, exchangeId, inboxAttempt, resumeOf }) => ({
          id: inboxAttempt, text, source: { exchangeId, inboxAttempt, resumeOf },
        }),
        readCodexInboxDelivery: async (id, _binding, messageId) => {
          native.push([id, messageId])
          return { status: outcome, text: 'Already completed', turnId: 'native-1' }
        },
        async finishRecoveredInbox(sessionId, target, text) {
          replies.push(text)
          await rt.inboxReply(blocked.id, sessionId, target, text)
        },
      }
      install(rt)
      await rt.bootBotInbox()
      for (let step = 0; step < 4; step++) {
        t.mock.timers.tick(0)
        await new Promise(resolve => setImmediate(resolve))
      }
      if (outcome === 'interrupted') {
        assert.equal(messages.length, 1)
        assert.equal(messages[0].source.exchangeId, blocked.id)
        assert.match(messages[0].source.resumeOf, /^resume\/request\//u)
        assert.match(messages[0].text, /Check what is already done/u)
        assert.doesNotMatch(messages[0].text, /Original request/u)
        assert.equal(rt.inboxForChat('recipient', 'recipient')[0].acceptedAt, 500)
      } else {
        assert.ok(messages.every(message => message.source.exchangeId !== blocked.id))
        assert.equal(blocked.state, outcome === 'completed' ? 'replied' : 'stopped')
      }
      assert.deepEqual(replies, outcome === 'completed' ? ['Already completed'] : [])
      assert.deepEqual(native, outcome === 'user-stop' ? [] : [['recipient', 'request']])
    })
  }
})
