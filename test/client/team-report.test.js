import assert from 'node:assert/strict'
import test from 'node:test'
import { earlierReports, reportSessionUsage, turnReport } from '../../src/client/team-report.js'

const bot = { model: 'local-claude-code/sonnet' }
const result = { agent: 'claude', command: 'usage' }
const liveResult = { ...result, seq: 81, messageId: undefined }
const step = { status: 'settled', finalNode: { seq: 81, requestConfig: { provider: 'local-claude-code' } } }
const user = (text, seq, rpcId) => ({ seq, kind: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })

test('team report follows the human command admitted to this step across streaming and reload', () => {
  const owner = user('/usage', 71, 'godbot-slash:local-claude-code:123')
  const runtime = { kind: 'context', seq: 75, source: { kind: 'time-context' } }
  assert.deepEqual(turnReport({ model: 'local-codex-cli/new' }, step, [owner], [], [runtime]), liveResult)
  assert.deepEqual(turnReport(bot, step, [user('hello', 52)], [owner, user('future draft', 82)], []), liveResult)
  assert.equal(turnReport(bot, { ...step, status: 'running' }, [owner], [], []), undefined)
  assert.equal(turnReport(bot, step, [owner], [user('make a chart about usage', 77)], []), undefined)
  assert.equal(turnReport(bot, step, [user('Tell me about /usage', 71)], [], []), undefined)
  assert.equal(turnReport(bot, step, [user('/usage', 71, 'godbot-slash:local-antigravity:123')], [], []), undefined)
  assert.equal(turnReport(bot, step, [owner], [], [{ ...runtime, source: { kind: 'bot', role: 'request' } }]), undefined)
  assert.equal(turnReport(bot, step, [{ ...owner, content: [...owner.content, { type: 'image' }] }], [], []), undefined)
})

test('archived report rows never borrow commands from a different turn, part, or room', () => {
  const native = 'You are currently using your subscription to power your Claude Code usage'
  const rows = [
    { kind: 'user', turn: 1, text: '/usage' },
    { kind: 'bot', turn: 1, text: native, seq: 8, sessionId: 'old-part' },
    { kind: 'bot', turn: 2, text: 'different turn' },
    { kind: 'divider' }, { kind: 'bot', turn: 1, text: 'different part' },
    { kind: 'user', turn: 4, text: '/usage' }, { kind: 'event' }, { kind: 'bot', turn: 4, text: 'another actor' },
  ]
  const marked = earlierReports(rows, bot)
  assert.deepEqual(marked[1].nativeReport, { ...result, seq: 8, partId: 'old-part' })
  assert.deepEqual(marked.filter(row => row.nativeReport).map(row => row.text), [native])
  assert.strictEqual(earlierReports(rows, undefined), rows)
  assert.deepEqual(earlierReports(rows, { model: 'local-antigravity/flash' })[1].nativeReport, { ...result, seq: 8, partId: 'old-part' })
  assert.equal(earlierReports([rows[0], { ...rows[1], text: 'This provider has a different /usage output' }], bot)[1].nativeReport, undefined)
})

test('native Session totals must come from the displayed assistant event in its own part', () => {
  const data = { totals: { inputTokens: 86 }, models: [] }
  const entries = [{ type: 'event', event: { seq: 8, type: 'assistant/message',
    data: { message: { id: 'right', source: { provider: 'local-claude-code', replayState: { response: { godbotClaudeSessionUsage: data } } } } } } }]
  assert.equal(reportSessionUsage(entries, 8, 'right'), data)
  assert.equal(reportSessionUsage(entries, 7, 'right'), undefined)
  assert.equal(reportSessionUsage(entries, 8, 'different'), null)
  assert.equal(reportSessionUsage([], 8), undefined)
  entries[0].event.data.message.source.provider = 'local-codex-cli'
  assert.equal(reportSessionUsage(entries, 8, 'right'), null)
})
