import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installRouting, mentionedConversation, relatedBotMessages } from '../../src/host/team-runtime/core/conversation-routing.js'
import { install as installDelivery } from '../../src/host/team-runtime/core/delivery.js'

test('task identifiers distinguish similar requests and can anchor a short followup', () => {
  assert.ok(relatedBotMessages('OPS-213', 'Investigate wallet reconciliation OPS-213'))
  assert.equal(relatedBotMessages('Review wallet reconciliation OPS-214', 'Review wallet reconciliation OPS-213'), false)
  assert.equal(relatedBotMessages('Please check on this now', 'Could you check on this again'), false)
  assert.ok(relatedBotMessages('复核钱包对账和账户余额', '检查钱包对账和账户余额'))
})

test('a recorded handoff keeps its origin through new parts, but a shared conversation has no default origin', () => {
  const bot = { id: 'worker', sessionId: 'worker-current', segments: [{ sessionId: 'worker-start' }] }
  const peer = { id: 'sender', sessionId: 'sender-current', segments: [{ sessionId: 'sender-start' }], openParts: [{ sessionId: 'sender-other' }] }
  const records = [
    { event: 'delivered', sessionId: 'worker-start', fromPart: 'sender-start', opensConversation: true },
    { event: 'delivered', sessionId: 'worker-current', fromPart: 'sender-current' },
    { event: 'delivered', sessionId: 'sender-other', fromPart: 'worker-current' },
  ]
  const rt = { ledger: { importer() {}, records: () => records } }
  installDelivery(rt)
  assert.equal(rt.conversationOpeningFrom(bot, peer, 'worker-current'), 'sender-start')
  records.push({ event: 'delivered', sessionId: 'worker-current', fromPart: 'sender-other' })
  assert.equal(rt.conversationOpeningFrom(bot, peer, 'worker-current'), undefined)
})

test('task keys are uppercase project keys; standards, versions and lowercase names are not', () => {
  // A checksum two messages mention is no shared task.
  assert.equal(relatedBotMessages('Release archive SHA-256 attached', 'Verify the SHA-256 of the download'), false)
  // Nor do two standards, model versions or Bot names veto messages about the same work.
  assert.ok(relatedBotMessages('复核钱包对账和账户余额，编码 UTF-8', '检查钱包对账和账户余额，校验 SHA-256'))
  assert.ok(relatedBotMessages('Compare GPT-6.2 wallet reconciliation totals', 'Compare GPT-5 wallet reconciliation totals'))
  assert.ok(relatedBotMessages('Ask gemini-3 about wallet reconciliation totals', 'Ask gemini-2 about wallet reconciliation totals'))
  // A key counts inside Chinese text, and different keys still tell tasks apart.
  assert.ok(relatedBotMessages('请处理GB-12的退回意见', '跟进GB-12'))
  assert.equal(relatedBotMessages('请处理GB-12的退回意见', '请处理GB-13的退回意见'), false)
})

const sid = n => `session-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

// The current thread holds an archived conversation (the Bot's first part, which has the
// Bot's id, and A, ended by New session) and the current one (B1, which a context handoff
// carried on to B2). An open part holds a background conversation (C).
const worker = () => ({
  id: sid(1),
  sessionId: sid(4),
  segments: [{ sessionId: sid(1) }, { sessionId: sid(2), manual: true }, { sessionId: sid(3) }],
  openParts: [{ sessionId: sid(5), segments: [] }],
})

test('a session ID in a message names that conversation of the receiving Bot, through later parts', () => {
  const bot = worker()
  assert.equal(mentionedConversation(bot, `Release done. 原发起会话 ${sid(3)}。`), sid(4), 'an earlier part names the conversation it went on in')
  assert.equal(mentionedConversation(bot, `原发起会话${sid(3).toUpperCase()}。`), sid(4), 'inside Chinese text and in capitals')
  assert.equal(mentionedConversation(bot, `Earlier: ${sid(2)}`), sid(2), 'an archived conversation is named by its last part')
  assert.equal(mentionedConversation(bot, `See ${sid(5)}`), sid(5), 'a background conversation')
  assert.equal(mentionedConversation(bot, `${sid(3)} and ${sid(4)}`), sid(4), 'two parts of one conversation')
  assert.equal(mentionedConversation(bot, `${sid(3)} or ${sid(5)}`), undefined, 'two conversations leave the choice to the topic')
  assert.equal(mentionedConversation(bot, `Started in ${sid(1)}`), sid(2), 'the Bot\'s first part has the Bot\'s id')
  assert.equal(mentionedConversation(bot, `Mine is ${sid(9)}`), undefined, 'a Session that is not the Bot\'s')
  assert.equal(mentionedConversation(bot, `group-${sid(3)}`), undefined, 'part of a longer identifier')
  assert.equal(mentionedConversation(bot, 'No session here'), undefined)
})

test('the named conversation comes first, then the handoff origin, then a session ID in the text', () => {
  const bot = worker()
  const sender = { id: 'sender', sessionId: 'sender-current', segments: [] }
  const records = []
  const rt = { live: new Map(), ledger: { importer() {}, records: () => records } }
  installDelivery(rt)
  installRouting(rt)
  const text = `Release done. Originating conversation ${sid(3)}.`
  assert.deepEqual(rt.botMessageDestination(sender, bot, { fromPart: 'sender-current', text }), { part: sid(4), by: 'mentioned' })
  assert.deepEqual(rt.botMessageDestination(sender, bot, { fromPart: 'sender-current', named: sid(2), text }), { part: sid(2), by: 'named' })
  assert.equal(rt.botMessageDestination(sender, bot, { fromPart: 'sender-current', text: 'Release done.' }), undefined)
  // The worker's background conversation opened the sender's: updates go back there.
  records.push({ event: 'delivered', sessionId: 'sender-current', fromPart: sid(5), opensConversation: true })
  assert.deepEqual(rt.botMessageDestination(sender, bot, { fromPart: 'sender-current', text }), { part: sid(5) })
  assert.deepEqual(rt.botMessageDestination(sender, bot, { fromPart: 'sender-current', named: sid(3), text }), { part: sid(3), by: 'named' })
})
