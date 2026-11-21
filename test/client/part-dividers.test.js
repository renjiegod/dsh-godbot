import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withoutEmptyParts } from '../../src/client/team-ui/part-dividers.js'

const line = time => ({ kind: 'divider', time })
const said = (text, time) => ({ kind: 'bot', text, time })

test('the lines of earlier parts nobody talked in collapse into the last one', () => {
  const items = [said('hello', 1), line(2), line(3), said('again', 4), line(5)]
  assert.deepEqual(withoutEmptyParts(items), [said('hello', 1), line(3), said('again', 4)])
  assert.deepEqual(withoutEmptyParts([line(1), line(2)]), [])
})

test('with every earlier part loaded, a line with nothing above it is left out', () => {
  // Two empty parts, then a part opened again later whose greeting was written before.
  const items = [line(10), line(20), said('greeting', 5), line(30), said('question', 31)]
  assert.deepEqual(withoutEmptyParts(items), [line(20), said('greeting', 5), line(30), said('question', 31)])
  assert.deepEqual(withoutEmptyParts(items, { complete: true }), [said('greeting', 5), line(30), said('question', 31)])
  // Older pages still to load may hold what is above that line.
  assert.deepEqual(withoutEmptyParts(items, { complete: false })[0], line(20))
  assert.deepEqual(withoutEmptyParts([said('greeting', 5)], { complete: true }), [said('greeting', 5)])
})

test('a New session links only to the part its package names, while the list can open it', async () => {
  const { previousPart } = await import('../../src/client/team-ui/part-dividers.js')
  const bot = { id: 'b', sessionId: 'p3', parts: ['p1', 'p2'], openParts: [{ sessionId: 'o1', parts: ['o0'] }] }
  assert.equal(previousPart(bot, 'p3', { handoff: true, fromPart: 'p2' }), 'p2')
  assert.equal(previousPart(bot, 'p3', { handoff: true, fromPart: 'o1' }), 'o1')
  // A package from before `fromPart` names nothing; the thread order is no guide.
  assert.equal(previousPart(bot, 'p3', { handoff: true }), undefined)
  // An open thread's own earlier part is not in the list, nor is the session itself.
  assert.equal(previousPart(bot, 'p3', { handoff: true, fromPart: 'o0' }), undefined)
  assert.equal(previousPart(bot, 'p3', { handoff: true, fromPart: 'p3' }), undefined)
  // A New session opened while the Bot was busy links to the part still running.
  assert.equal(previousPart(bot, 'p3', { handoff: true, opening: true, fromPart: 'o1' }), 'o1')
  assert.equal(previousPart(undefined, 'p3', { fromPart: 'p2' }), undefined)
})
