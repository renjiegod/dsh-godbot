import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relatedBotMessages } from '../../src/host/team-runtime/core/conversation-routing.js'
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
