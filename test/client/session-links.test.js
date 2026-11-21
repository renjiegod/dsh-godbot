import { strict as assert } from 'node:assert'
import test from 'node:test'
import { botHome } from '../../src/client/session-links.js'

test('home honors an explicit task owner and never pulls a different live conversation back during reconciliation', () => {
  const r = { byId: { godbot: {}, worker: {} }, roomsById: { room: {} }, agentOf: {}, mainBotId: 'godbot' }
  const home = botHome('worker', 'godbot')
  assert.equal(home(r, 'godbot'), 'worker')
  assert.equal(home(r, 'room'), 'room')
  assert.equal(home(r, 'plain-dsh-session'), 'plain-dsh-session')
  assert.equal(botHome(undefined, 'godbot')(r, 'worker'), 'worker')
  assert.equal(botHome(undefined, 'worker')(r, undefined), 'worker')
  assert.equal(botHome('forgotten', 'archived')(r, 'unrelated'), 'godbot')
  r.byId.worker = { id: 'worker', sessionId: 'worker-part-2' }
  assert.equal(botHome('worker', 'godbot')(r, 'worker'), 'worker-part-2')
})
