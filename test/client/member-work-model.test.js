import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasProcess, memberWorkTarget, otherWorkers, workAt } from '../../src/client/team-ui/member-work-model.js'
import { processSegments, runningCalls } from '../../src/client/execution-segments.js'

test('the panel shows the turn its opener named, else the one the member runs now', () => {
  const live = { botId: 'claude', sessionId: 'member-part', turn: 5, tool: 'Bash' }
  assert.deepEqual(memberWorkTarget({}, live), { sessionId: 'member-part', turn: 5, running: true })
  assert.deepEqual(memberWorkTarget({ sessionId: 'member-part', turn: 5 }, live), { sessionId: 'member-part', turn: 5, running: true })
  // A reply's turn, while the member already works on the next one.
  assert.deepEqual(memberWorkTarget({ sessionId: 'member-part', turn: 3 }, live),
    { sessionId: 'member-part', turn: 3, running: false, newer: { sessionId: 'member-part', turn: 5 } })
  assert.deepEqual(memberWorkTarget({ sessionId: 'member-part', turn: 3 }, null), { sessionId: 'member-part', turn: 3, running: false })
  // Nothing to show: no turn named and no work going on (or a turn adopted after a reload).
  assert.equal(memberWorkTarget({}, null), null)
  assert.equal(memberWorkTarget({}, { botId: 'claude', sessionId: 'member-part' }), null)
})

test('a line opens its process only when its turn ran tools', () => {
  assert.equal(hasProcess({ sessionId: 's', turn: 2, tools: 3 }), true)
  assert.equal(hasProcess({ sessionId: 's', turn: 2 }), false)
  assert.equal(hasProcess({ sessionId: 's', turn: 2, tools: 0 }), false)
  assert.equal(hasProcess(undefined), false)
  assert.deepEqual(workAt({ sessionId: 's', turn: 2, tools: 3, tool: 'Bash' }), { sessionId: 's', turn: 2 })
  assert.deepEqual(workAt({ sessionId: '', turn: 2 }), {})
})

test('the switcher lists the other members whose live turn it can show', () => {
  const entries = [
    { botId: 'claude', sessionId: 'a', turn: 1 },
    { botId: 'codex', sessionId: 'b', turn: 2, tool: 'Shell' },
    { botId: 'gemini', switching: true },
    { self: true, sessionId: 'c', turn: 1 },
  ]
  assert.deepEqual(otherWorkers(entries, 'claude'), [{ botId: 'codex', sessionId: 'b', turn: 2 }])
  assert.deepEqual(otherWorkers(undefined, 'claude'), [])
})

test('a process folds each run of tool calls between the Bot\'s words into one group', () => {
  const tool = (id, status = 'completed') => ({ type: 'tool', id, name: 'Bash', status })
  const segments = processSegments([
    { type: 'text', seq: '1:0', text: 'Let me look.' },
    tool('a'), tool('b'),
    { type: 'text', seq: '2:0', text: '' },
    tool('c', 'running'),
    { type: 'text', seq: '3:0', text: 'Done.' },
  ])
  assert.deepEqual(segments.map(segment => segment.type === 'tools' ? segment.events.map(event => event.id) : segment.event.text),
    ['Let me look.', ['a', 'b', 'c'], 'Done.'])
  assert.equal(runningCalls(segments[1].events), 1)
  assert.deepEqual(processSegments(undefined), [])
})
