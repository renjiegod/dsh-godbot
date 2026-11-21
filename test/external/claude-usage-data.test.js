import assert from 'node:assert/strict'
import test from 'node:test'
import { projectClaudeSessionUsage } from '../../src/drivers/external/claude-usage-data.js'

test('projects the native usage twin attached to this command without session IDs, rate-limit data or account details', () => {
  const report = { session: {
    total_api_duration_ms: 5234, total_duration_ms: 9999, total_lines_added: 4, total_lines_removed: 3,
    total_cost_usd: 0.013, model_usage: {
      'claude-test': { inputTokens: 3, outputTokens: 1001, cacheReadInputTokens: 9021, cacheCreationInputTokens: 1200, costUSD: 0.013, secret: 'redacted' },
      '/Users/private': { inputTokens: 999 },
    }, session_id: 'private',
  }, rate_limits: { account: 'private' } }
  assert.deepEqual(projectClaudeSessionUsage(report), {
    apiDurationMs: 5234, durationMs: 9999, linesAdded: 4, linesRemoved: 3, totalCostUsd: 0.013,
    models:[{ name:'claude-test', inputTokens:3, outputTokens:1001, cacheReadTokens:9021, cacheCreationTokens:1200, costUsd:0.013 }],
  })
})

test('preserves observed zeroes; missing snapshots and malformed future data do not become zero-usage sessions', () => {
  assert.deepEqual(projectClaudeSessionUsage({session:{total_cost_usd:0,total_lines_removed:0}}), {totalCostUsd:0,linesRemoved:0,models:[]})
  assert.equal(projectClaudeSessionUsage({session:{total_cost_usd:'0',total_lines_added:-4,total_api_duration_ms:Infinity,model_usage:{}}}),null)
  assert.equal(projectClaudeSessionUsage({total_duration_ms:10}),null)
  assert.equal(projectClaudeSessionUsage(null),null)
})

test('session statistics bind to the synthetic usage response, never an assistant description', async () => {
  const { claudeUsageFrame } = await import('../../src/drivers/external/claude-usage-data.js')
  const frame = { type: 'assistant', local_command_run: { command: 'usage', args: '' },
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'report' }] },
    usage_report: { session: { total_duration_ms: 2000, total_lines_added: 0 } } }
  assert.deepEqual(claudeUsageFrame(frame), { text: 'report', sessionUsage: { durationMs: 2000, linesAdded: 0, models: [] } })
  assert.equal(claudeUsageFrame({ ...frame, local_command_run: { command: 'anything' } }), undefined)
  assert.equal(claudeUsageFrame({ ...frame, message: { ...frame.message, model: 'claude' } }), undefined)
  assert.equal(claudeUsageFrame({ ...frame, parent_tool_use_id: 'another-session' }), undefined)
})
