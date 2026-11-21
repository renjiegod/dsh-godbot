import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionFloor } from '../../src/host/team-runtime/core/parts.js'

const part = (sessionId, extra = {}) => ({ sessionId, ...extra })

test('pages of earlier parts stop where a New session began', () => {
  // p1 → p2 moved on by itself; the user started a New session at p3; p3 → p4 moved on.
  const parts = [part('p1'), part('p2', { manual: true, fallback: 'manual' }), part('p3'), part('p4')]
  assert.equal(sessionFloor(parts, 3), 2, 'p4 shows p3 above it, not the session before')
  assert.equal(sessionFloor(parts, 2), 2, 'p3 starts a session: nothing above it')
  assert.equal(sessionFloor(parts, 1), 0, 'p2 shows p1 above it')
  assert.equal(sessionFloor([part('only')], 0), 0)
})

test('a New session from before the flag is known by its note fallback', () => {
  const parts = [part('p1', { fallback: 'manual' }), part('p2', { fallback: 'overflow' }), part('p3')]
  assert.equal(sessionFloor(parts, 2), 1)
})

test('the seams an opened session leaves are not read across', () => {
  const parts = [part('p1'), part('p2', { cut: true }), part('p3', { cut: true }), part('p4')]
  assert.equal(sessionFloor(parts, 3), 3)
  assert.equal(sessionFloor(parts, 2), 2)
})
