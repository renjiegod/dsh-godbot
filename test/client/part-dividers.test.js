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
