import assert from 'node:assert/strict'
import { test } from 'node:test'
import { earlierPlace, focusOpenPart, openEarlierBeside, openEarlierOfThread, ownChatParts, startOpenPart, threadOfPart, threadStart } from '../../src/host/team-runtime/core/threads.js'
import { sessionFloor } from '../../src/host/team-runtime/core/parts.js'

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

// The Codex Bot from the report: three earlier sessions, the current one running, and a
// busy-time part nobody talked in.
const codexBot = () => ({
  id: 'p1', createdAt: 1_000, sessionId: 'p4',
  segments: [
    { sessionId: 'p1', endedAt: 2_000, note: '## Goals' },
    { sessionId: 'p2', endedAt: 3_000, fallback: 'manual', manual: true },
    { sessionId: 'p3', endedAt: 4_000, fallback: 'manual', manual: true },
  ],
  openParts: [{ sessionId: 'p5', segments: [], threadStartedAt: 4_500 }],
})

test('an earlier part is found in the current chain or in a background one', () => {
  const bot = codexBot()
  assert.deepEqual(earlierPlace(bot, 'p2'), { thread: 'current', at: 1, segments: bot.segments })
  assert.equal(earlierPlace(bot, 'p4'), undefined, 'the current part is not an earlier one')
  assert.equal(earlierPlace(bot, 'p5'), undefined, 'a background part is not an earlier one')
  bot.openParts[0].segments = [{ sessionId: 'p0', endedAt: 1_500 }]
  assert.deepEqual(earlierPlace(bot, 'p0'), { thread: 'open', index: 0, at: 0, segments: bot.openParts[0].segments })
  assert.deepEqual(ownChatParts(bot), ['p4', 'p1', 'p2', 'p3', 'p5', 'p0'])
  assert.deepEqual(ownChatParts({ id: 'fresh' }), ['fresh'])
})

test('opening an earlier part beside a running one leaves the running one going on with its chain', () => {
  const bot = codexBot()
  assert.equal(openEarlierBeside(bot, 'p3', 9_000), true)
  assert.equal(bot.sessionId, 'p3', 'the part the user opened is current')
  assert.deepEqual(bot.segments, [], 'it begins a thread of its own')
  assert.equal(bot.threadStartedAt, 3_000, 'that thread began when the part did')
  assert.deepEqual(bot.openParts, [
    { sessionId: 'p5', segments: [], threadStartedAt: 4_500 },
    { sessionId: 'p4', segments: [{ sessionId: 'p1', endedAt: 2_000, note: '## Goals' }, { sessionId: 'p2', endedAt: 3_000, fallback: 'manual', manual: true, cut: true }], startedAt: 9_000 },
  ])
  // The running part reads its own history, and the parts on either side of the one that
  // left no longer page into each other.
  assert.equal(threadOfPart(bot, 'p1')?.thread, 'open')
  assert.equal(threadStart(bot, 'p4'), undefined, 'the running thread still began with the Bot')
  const running = [...bot.openParts[1].segments, { sessionId: 'p4' }]
  assert.equal(sessionFloor(running, 2), 2)
  // Every part is still one of the Bot's.
  assert.deepEqual(ownChatParts(bot).toSorted(), ['p1', 'p2', 'p3', 'p4', 'p5'])
  assert.equal(openEarlierBeside(bot, 'nowhere'), false)
})

test('the first part of a chain opened beside a running one begins with its chain', () => {
  const bot = codexBot()
  bot.threadStartedAt = 1_200
  assert.equal(openEarlierBeside(bot, 'p1', 9_000), true)
  assert.equal(bot.threadStartedAt, 1_200)
  assert.deepEqual(bot.openParts.at(-1).segments.map(segment => segment.sessionId), ['p2', 'p3'])
  assert.equal(bot.openParts.at(-1).threadStartedAt, 2_000, 'the running thread now begins where the part that left it ended')
  // Opening a part of that background chain beside the now running p1 moves p1 aside too.
  assert.equal(openEarlierBeside(bot, 'p2', 9_500), true)
  assert.equal(bot.sessionId, 'p2')
  assert.equal(bot.threadStartedAt, 2_000, 'it began when the part before it ended')
  assert.deepEqual(bot.openParts.map(part => part.sessionId), ['p5', 'p4', 'p1'])
  assert.deepEqual(bot.openParts[1].segments.map(segment => segment.sessionId), ['p3'])
  assert.equal(bot.openParts[1].threadStartedAt, 3_000)
  assert.equal(bot.openParts[2].threadStartedAt, 1_200, 'p1 took the start its chain had')
})

test('opening an earlier part of a background chain while idle archives the current part in the current chain', () => {
  const bot = codexBot()
  bot.openParts[0].segments = [{ sessionId: 'o1', endedAt: 4_100 }, { sessionId: 'o2', endedAt: 4_200 }]
  assert.equal(openEarlierOfThread(bot, 'p2', 9_000), false, 'a part of the current chain is not one')
  assert.equal(openEarlierOfThread(bot, 'o2', 9_000), true)
  assert.equal(bot.sessionId, 'o2')
  assert.deepEqual(bot.openParts[0].segments, [{ sessionId: 'o1', endedAt: 4_100, cut: true }])
  assert.deepEqual(bot.segments.at(-1), { sessionId: 'p4', endedAt: 9_000, cut: true })
  assert.deepEqual(ownChatParts(bot).toSorted(), ['o1', 'o2', 'p1', 'p2', 'p3', 'p4', 'p5'])
})
