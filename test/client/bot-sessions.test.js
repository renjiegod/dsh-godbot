import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botSessions, lastActivity, ownPartIds, sessionLabel, sessionMeta, shortList } from '../../src/client/team-ui/bot-sessions.js'

// The Codex Bot from the report as the host lists it: p4 current and running, p5 a
// busy-time part nobody talked in, p6 another one still running in the background with
// an earlier part of its own.
const bot = {
  id: 'p1', name: 'Codex', sessionId: 'p4', parts: ['p1', 'p2', 'p3'],
  openParts: [{ sessionId: 'p5', parts: [] }, { sessionId: 'p6', parts: ['p0'] }],
  partOrder: ['p1', 'p0', 'p2', 'p3', 'p4', 'p5', 'p6'],
}
const roster = {
  emptyParts: { p1: ['p5'] },
  partsRunning: { p4: true, p6: true },
  questions: { p3: { callId: 'c' } },
  partTitles: { p1: "what's your model name", p3: 'issues/2025 fix', p4: 'continue working on issues/2020' },
  newSessions: {},
}

test('every session of the chat is listed newest first, background chains included', () => {
  const entries = botSessions(bot, roster)
  assert.deepEqual(entries.map(entry => entry.id), ['p6', 'p4', 'p3', 'p2', 'p0', 'p1'], 'the empty busy-time part is left out')
  assert.deepEqual(entries.find(entry => entry.id === 'p4'), { id: 'p4', number: 5, current: true, background: false, running: true, waiting: false, title: 'continue working on issues/2020' })
  assert.equal(entries.find(entry => entry.id === 'p6').background, true)
  assert.equal(entries.find(entry => entry.id === 'p3').waiting, true)
  assert.equal(entries.find(entry => entry.id === 'p0').number, 2)
})

test('a session is named by its first prompt, else by its own title, else New session or its number', () => {
  const [p6, p4, p3, p2] = botSessions(bot, roster)
  assert.equal(sessionLabel(p4, { bot, roster }), 'continue working on issues/2020')
  assert.equal(sessionLabel(p3, { bot, roster, rowTitle: 'Codex' }), 'issues/2025 fix')
  assert.equal(sessionLabel(p2, { bot, roster, rowTitle: 'Codex' }), 'Session 3', 'a part titled by the Bot\'s name is numbered')
  assert.equal(sessionLabel(p6, { bot, roster, rowTitle: 'Release notes' }), 'Release notes')
  const fresh = { ...bot, sessionId: 'p7' }
  const [current] = botSessions(fresh, { ...roster, newSessions: { p1: 'empty' } })
  assert.equal(current.id, 'p7')
  assert.equal(sessionLabel(current, { bot: fresh, roster: { ...roster, newSessions: { p1: 'empty' } } }), 'New session')
})

test('a row says a question waits, a turn runs, or how long ago it was active', () => {
  const [p6, , p3, p2] = botSessions(bot, roster)
  assert.equal(sessionMeta(p3, 0).tone, 'wait')
  assert.equal(sessionMeta(p6, 0).tone, 'run')
  assert.equal(sessionMeta(p2, Date.now() - 5 * 60_000).tone, undefined)
  assert.notEqual(sessionMeta(p2, Date.now() - 5 * 60_000).text, '')
  assert.equal(sessionMeta(p2, undefined).text, '')
})

test('a short list keeps the current, running and waiting sessions, then the newest', () => {
  const entries = botSessions(bot, roster)
  assert.deepEqual(shortList(entries, 3).map(entry => entry.id), ['p6', 'p4', 'p3'])
  assert.deepEqual(shortList(entries, 4).map(entry => entry.id), ['p6', 'p4', 'p3', 'p2'])
  const quiet = botSessions(bot, { ...roster, partsRunning: {}, questions: {} })
  assert.deepEqual(shortList(quiet, 2).map(entry => entry.id), ['p6', 'p4'])
  const old = botSessions({ ...bot, sessionId: 'p0', parts: ['p1', 'p2', 'p3', 'p4'], openParts: [{ sessionId: 'p6', parts: [] }] }, { ...roster, partsRunning: {}, questions: {} })
  assert.deepEqual(shortList(old, 2).map(entry => entry.id), ['p6', 'p0'], 'the current session stays in even when it is old')
})

test('a Bot is as recent as its latest session, whichever one is open', () => {
  assert.deepEqual(ownPartIds(bot), ['p4', 'p5', 'p6', 'p1', 'p2', 'p3', 'p0'])
  const stamps = { p1: 100, p2: 200, p3: 300, p4: 900, p5: 400, p6: 700, p0: 50 }
  assert.equal(lastActivity(bot, stamps), 900)
  // Opening the oldest session makes it current; the Bot is no less recent for it.
  const opened = { ...bot, sessionId: 'p1', parts: ['p2', 'p3'], openParts: [...bot.openParts, { sessionId: 'p4', parts: [] }] }
  assert.equal(lastActivity(opened, stamps), 900)
  assert.equal(lastActivity({ id: 'new', createdAt: 42 }, {}), 42, 'a Bot with no session activity yet sorts by when it was made')
})
