import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relatedBotMessages } from '../../src/host/team-runtime/core/conversation-routing.js'

test('task identifiers distinguish similar requests and can anchor a short followup', () => {
  assert.ok(relatedBotMessages('OPS-213', 'Investigate wallet reconciliation OPS-213'))
  assert.equal(relatedBotMessages('Review wallet reconciliation OPS-214', 'Review wallet reconciliation OPS-213'), false)
  assert.equal(relatedBotMessages('Please check on this now', 'Could you check on this again'), false)
  assert.ok(relatedBotMessages('复核钱包对账和账户余额', '检查钱包对账和账户余额'))
})
