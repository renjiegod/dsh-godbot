import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastClosedTurn } from '../../src/client/team-ui/btw-model.js'

// The chat's turns as the shell keeps them: a map from turn number to its start and end.
const turnsOf = (...entries) => new Map(entries.map(entry => [entry.turn, entry]))

test('the last closed turn moves when a turn closes, not when one opens', () => {
  assert.equal(lastClosedTurn(undefined), undefined)
  // The shell's timeline before it has loaded is an empty one, like a chat before its first turn.
  assert.equal(lastClosedTurn(turnsOf()), undefined)
  assert.equal(lastClosedTurn(turnsOf({ turn: 1, start: { seq: 1 } })), null)
  assert.equal(lastClosedTurn(turnsOf({ turn: 1, start: { seq: 1 }, end: { seq: 4 } })), 1)
  // A second turn opening leaves it; closing moves it.
  assert.equal(lastClosedTurn(turnsOf({ turn: 1, start: { seq: 1 }, end: { seq: 4 } }, { turn: 2, start: { seq: 5 } })), 1)
  assert.equal(lastClosedTurn(turnsOf({ turn: 1, start: { seq: 1 }, end: { seq: 4 } }, { turn: 2, start: { seq: 5 }, end: 9 })), 2)
})

test('older turns loaded after the newest leave it as it was', () => {
  const page = new Map([[7, { turn: 7, start: { seq: 30 }, end: { seq: 40 } }]])
  page.set(3, { turn: 3, start: { seq: 10 }, end: { seq: 12 } })
  assert.equal(lastClosedTurn(page), 7)
})
