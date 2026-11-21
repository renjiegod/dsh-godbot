import assert from 'node:assert/strict'
import test from 'node:test'
import { parseClaudeUsage } from '../../src/client/claude-usage.js'

// Same wire format as the Claude Code headless /usage response.
const usage = `You are currently using your subscription to power your Claude Code usage

Current session: 2% used · resets 11:09am (Asia/Taipei)
Current week (all models): 0% used · resets Nov 26 at 11:59pm (Asia/Taipei)
Current week (Test model): 12.5% used · resets Nov 27 at 12am (Asia/Taipei)

What's contributing to your usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 1,589 requests · 29 sessions
  80%  Start fresh when you switch tasks · run /clear
  19%  Review active sessions · share covers whole sessions, not only subagents
  Top skills: /review 24%, /sample:verify 2%, +2 more
  Top subagents: general-purpose 4%, planner 1%
  Top plugins: sample 2%

Last 7d · 6,683 requests · 36 sessions
  11%  Turn off skills you don't use · 18k tokens per request
  Top sessions: Example, with a comma 12%, Another session 8%`

test('Claude usage keeps per-model limits, local reset times, recommendations, and ranked totals', () => {
  const report = parseClaudeUsage(usage)
  assert.equal(report.raw, usage)
  assert.deepEqual(report.quota, [
    { label: 'Current session', percent: 2, reset: 'Resets 11:09am (Asia/Taipei)' },
    { label: 'Current week (all models)', percent: 0, reset: 'Resets Nov 26 at 11:59pm (Asia/Taipei)' },
    { label: 'Current week (Test model)', percent: 12.5, reset: 'Resets Nov 27 at 12am (Asia/Taipei)' },
  ])
  assert.deepEqual(report.notes, ['Approximate · sessions on this machine only · shares overlap'])
  const [day, week] = report.periods
  assert.deepEqual([day.label, day.totals, week.label, week.totals], ['Last 24h', '1,589 requests · 29 sessions', 'Last 7d', '6,683 requests · 36 sessions'])
  assert.deepEqual(day.recommendations[1], { label: 'Review active sessions', percent: 19, detail: 'share covers whole sessions, not only subagents' })
  assert.deepEqual(day.tables.map(t => t.label), ['Skills', 'Subagents', 'Plugins'])
  assert.deepEqual(day.tables[0].items, [{label:'/review',percent:24},{label:'/sample:verify',percent:2}])
  assert.equal(day.tables[0].more, '+2 more')
  assert.deepEqual(week.tables[0], {label:'Sessions',items:[{label:'Example, with a comma',percent:12},{label:'Another session',percent:8}]})
  assert.deepEqual(report.unparsed, [])
})

test('flattened chat history has exactly the same structured values as the native multiline response', () => {
  const report = parseClaudeUsage(usage)
  const flattened = usage.replace(/\s+/gu, ' ')
  assert.deepEqual(parseClaudeUsage(flattened), {...report, raw:flattened})
})

test('optional reset and rank sections, extra fields and raw native output survive independently', () => {
  const text = 'Current week (New model): 0% used\r\nResets Dec 1 at 5pm (Pacific/Auckland)\r\nCurrent day: 6% used\r\nAdditional limit detail for this account.'
  const report = parseClaudeUsage(text)
  assert.deepEqual(report.quota[0], {label:'Current week (New model)',percent:0,reset:'Resets Dec 1 at 5pm (Pacific/Auckland)'})
  assert.deepEqual(report.quota[1], {label:'Current day',percent:6,reset:''})
  assert.deepEqual(report.unparsed, ['Additional limit detail for this account.'])
  assert.deepEqual(report.periods, [])
  assert.equal(report.raw, text)
})

test('unrecognized output and authentication errors are left to the verbatim command renderer', () => {
  for (const raw of [undefined, '', 'Not signed in. Run /login.', 'Failed to load usage data', 'In the docs: Current session: 18% used · resets noon', 'You are currently using your subscription to power your Claude Code usage\nFailed to load usage.']) {
    assert.equal(parseClaudeUsage(raw), null)
  }
  const wrapped = '<local-command-stdout>\x1b[33mCurrent session: 3% used\x1b[0m</local-command-stdout>'
  assert.equal(parseClaudeUsage(wrapped).quota[0].percent, 3)
  assert.equal(parseClaudeUsage(wrapped).raw, wrapped)
})

test('a percentage inside a native advice line and unfamiliar ranked groups keep their meaning', () => {
  const text = `Current session: 7% used
Last 24h · 2 requests · 1 session
  8% Keep 50% of the context available
  Top skills: /sample 7%
  Top projects: working copy 4%`
  const parsed = parseClaudeUsage(text)
  assert.deepEqual(parsed.periods[0].recommendations, [{label:'Keep 50% of the context available',percent:8,detail:''}])
  assert.deepEqual(parsed.periods[0].tables[0].items, [{label:'/sample',percent:7}])
  assert.deepEqual(parsed.unparsed, ['Top projects: working copy 4%'])
})
