import { strict as assert } from 'node:assert'
import test from 'node:test'
import { botHome } from '../../src/client/session-links.js'

test('home honors an explicit task owner and never pulls a different live conversation back during reconciliation', () => {
  const r = { byId: { chief: {}, worker: {} }, roomsById: { room: {} }, agentOf: {}, mainBotId: 'chief' }
  const home = botHome('worker', 'chief')
  assert.equal(home(r, 'chief'), 'worker')
  assert.equal(home(r, 'room'), 'room')
  assert.equal(home(r, 'plain-dsh-session'), 'plain-dsh-session')
  assert.equal(botHome(undefined, 'chief')(r, 'worker'), 'worker')
  assert.equal(botHome(undefined, 'worker')(r, undefined), 'worker')
  assert.equal(botHome('forgotten', 'archived')(r, 'unrelated'), 'chief')
  r.byId.worker = { id: 'worker', sessionId: 'worker-part-2' }
  assert.equal(botHome('worker', 'chief')(r, 'worker'), 'worker-part-2')
})
