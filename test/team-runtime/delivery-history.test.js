import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readDeliveryEvents, turnOf } from '../../src/host/team-runtime/core/resume.js'

test('delivery recovery reads every page and reconstructs the committed turn in order', async () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { exchangeId: 'queued-work' } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const rt = {
    async *eventsBackwards(id, signal, maxPages) {
      assert.equal(id, 'recipient')
      assert.equal(signal.aborted, false)
      assert.equal(maxPages, Infinity)
      yield* events.toReversed()
    },
  }
  const log = await readDeliveryEvents(rt, 'recipient')
  assert.deepEqual(log, events)
  assert.equal(turnOf(log, 'queued-work').reason.kind, 'completed')
})

test('delivery recovery keeps the engine receipt unknown when history is incomplete', async () => {
  const rt = {
    async *eventsBackwards() {
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } }
      throw new Error('Unable to read an older page')
    },
  }
  assert.equal(await readDeliveryEvents(rt, 'recipient'), undefined)
})
