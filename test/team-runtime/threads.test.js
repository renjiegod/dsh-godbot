import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusOpenPart, startOpenPart, threadStart } from '../../src/host/team-runtime/core/threads.js'

const botWith = () => ({
  id: 'bot', createdAt: 1_000, sessionId: 'part-3',
  segments: [{ sessionId: 'bot', endedAt: 2_000 }, { sessionId: 'part-2', endedAt: 3_000 }],
})

test('a part opened while the Bot was busy begins its own thread at the time it was made', () => {
  const bot = botWith()
  assert.equal(threadStart(bot, 'part-3'), undefined, 'the Bot\'s first thread began with the Bot')
  startOpenPart(bot, 'fresh', 5_000)
  assert.equal(bot.sessionId, 'fresh')
  assert.deepEqual(bot.segments, [])
  assert.equal(threadStart(bot, 'fresh'), 5_000)
  assert.deepEqual(bot.openParts, [{ sessionId: 'part-3', segments: [{ sessionId: 'bot', endedAt: 2_000 }, { sessionId: 'part-2', endedAt: 3_000 }], startedAt: 5_000 }])
  assert.equal(threadStart(bot, 'part-3'), undefined, 'the thread left in the background still began with the Bot')
  assert.equal(threadStart(bot, 'part-2'), undefined, 'an earlier part reads its own thread')
})

test('a thread keeps its start time when it swaps places with the current one', () => {
  const bot = botWith()
  startOpenPart(bot, 'fresh', 5_000)
  assert.equal(focusOpenPart(bot, 'part-3'), true)
  assert.equal(bot.sessionId, 'part-3')
  assert.equal(bot.threadStartedAt, undefined)
  assert.equal(threadStart(bot, 'part-3'), undefined)
  assert.equal(threadStart(bot, 'fresh'), 5_000, 'the busy-time thread keeps its start in the background')
  assert.equal(focusOpenPart(bot, 'fresh'), true)
  assert.equal(threadStart(bot, 'fresh'), 5_000)
  assert.equal(threadStart(bot, 'part-3'), undefined)
  // A second busy-time part from the busy-time thread pushes that thread, start and all.
  startOpenPart(bot, 'second', 9_000)
  assert.equal(threadStart(bot, 'second'), 9_000)
  assert.equal(threadStart(bot, 'fresh'), 5_000)
  assert.equal(threadStart(bot, 'nowhere'), undefined)
})

test('an open part saved before thread starts were kept reads as begun with the Bot', () => {
  const bot = { id: 'bot', createdAt: 1_000, sessionId: 'fresh', segments: [], openParts: [{ sessionId: 'old', segments: [], startedAt: 4_000 }] }
  assert.equal(threadStart(bot, 'old'), undefined)
  assert.equal(focusOpenPart(bot, 'old'), true)
  assert.equal(threadStart(bot, 'old'), undefined)
  assert.equal(threadStart(bot, 'fresh'), undefined)
})
