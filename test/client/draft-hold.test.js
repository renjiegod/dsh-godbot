import assert from 'node:assert/strict'
import test from 'node:test'
import { createDraftHolds, DRAFT_HOLD_SOURCE } from '../../src/client/team-ui/draft-hold.js'

function fakeSessions({ unknown = new Set() } = {}) {
  const retains = []
  return {
    retains,
    live: () => retains.filter(entry => !entry.released).map(entry => entry.sessionId),
    retain(sessionId, options) {
      if (unknown.has(sessionId)) throw new Error(`sessions.retain: unknown session ${sessionId}`)
      const entry = { sessionId, options, released: false }
      retains.push(entry)
      return { ready: Promise.resolve(), release: () => { entry.released = true } }
    },
  }
}

test('a draft with attachments keeps its Session once until the draft is empty', () => {
  const sessions = fakeSessions()
  const holds = createDraftHolds(sessions)
  holds.sync('s1', 1)
  holds.sync('s1', 2)
  assert.deepEqual(sessions.live(), ['s1'])
  assert.equal(sessions.retains.length, 1)
  assert.equal(sessions.retains[0].options.source, DRAFT_HOLD_SOURCE)
  holds.sync('s1', 0)
  assert.deepEqual(sessions.live(), [])
  holds.sync('s1', 0)
  assert.equal(sessions.retains.length, 1)
})

test('an empty draft takes no hold and an unknown Session is skipped', () => {
  const sessions = fakeSessions({ unknown: new Set(['gone']) })
  const holds = createDraftHolds(sessions)
  holds.sync('s1', 0)
  holds.sync('gone', 1)
  holds.sync(undefined, 1)
  assert.deepEqual(sessions.live(), [])
  assert.deepEqual(holds.held(), [])
})

test('holds end for Sessions the ready list no longer has, and with the client', () => {
  const sessions = fakeSessions()
  const holds = createDraftHolds(sessions)
  holds.sync('s1', 1)
  holds.sync('s2', 1)
  holds.prune({ phase: 'pending', ids: [] })
  assert.deepEqual(sessions.live(), ['s1', 's2'])
  holds.prune({ phase: 'ready', ids: ['s2'] })
  assert.deepEqual(sessions.live(), ['s2'])
  holds.dispose()
  assert.deepEqual(sessions.live(), [])
})

test('a Session that fails to open drops its hold', async () => {
  let released = false
  const holds = createDraftHolds({
    retain: () => ({ ready: Promise.reject(new Error('open failed')), release: () => { released = true } }),
  })
  holds.sync('s1', 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(released, true)
  assert.deepEqual(holds.held(), [])
})
