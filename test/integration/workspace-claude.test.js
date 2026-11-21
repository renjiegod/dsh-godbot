import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'

test('full-team Claude matches tool results by native call ID', { timeout: 5000 }, async (t) => {
  const fixture = fileURLToPath(new URL('../external/fixtures/fake-claude.mjs', import.meta.url))
  const engine = createWorkspaceClaudeEngine(
    'claude-code',
    { name: 'Claude Code', command: 'claude', args: [fixture] },
    { findExecutable: () => process.execPath },
  )
  t.after(() => engine.close())
  const session = await engine.open('trace', { cwd: tmpdir() })
  await engine.prompt(session, [{ type: 'text', text: 'GODBOT-CLAUDE-EXECUTION-TRACE test' }])
  const activity = []
  const traces = []
  for (;;) {
    const event = await session.next()
    if (event.type === 'error') throw event.error
    if (event.type === 'activity') {
      activity.push(event.text)
      traces.push(event.trace)
    }
    if (event.type === 'done') break
  }
  assert.deepEqual(activity, [
    '▸ Read · fixture-trace.txt · 调用',
    '▸ Grep · fixture-trace.txt · 调用',
    '▸ Grep · fixture-trace.txt · 失败',
    '▸ Read · fixture-trace.txt · 完成',
  ])
  assert.equal(traces[0].id, traces[3].id)
  assert.equal(traces[1].id, traces[2].id)
  assert.deepEqual(traces[0].input, { file_path: 'fixture-trace.txt' })
  assert.equal(traces[2].status, 'failed')
  assert.equal(traces[3].output, 'RAW_TRACE_OUTPUT')
})

test(
  'full-team Claude applies native reasoning to each process, preserves approvals, and resets on the same Bot',
  { timeout: 15000 },
  async (t) => {
    const fixture = fileURLToPath(new URL('../external/fixtures/fake-claude.mjs', import.meta.url))
    const engine = createWorkspaceClaudeEngine(
      'claude-code',
      { name: 'Claude Code', command: 'claude', args: [fixture] },
      { findExecutable: () => process.execPath },
    )
    t.after(() => engine.close())
    const models = await engine.listModels({ cwd: tmpdir() })
    assert.deepEqual(
      models.find((m) => m.id === 'sonnet').reasoning.efforts.map((x) => x.id),
      ['low', 'high', 'max'],
    )
    assert.equal(models.find((m) => m.id === 'unreasoned').reasoning, undefined)
    assert.equal(engine.defaultReasoning.defaultEffort, 'high')
    const a = await engine.open('one', { cwd: tmpdir(), model: 'sonnet' })
    const b = await engine.open('two', { cwd: tmpdir(), model: 'sonnet' })
    async function result(session, text, effort) {
      await engine.prompt(session, [{ type: 'text', text }], { effort })
      const events = []
      for (;;) {
        const event = await session.next()
        events.push(event)
        if (event.type === 'error') throw event.error
        if (event.type === 'permission') event.reply('deny')
        if (event.type === 'done') return events
      }
    }
    const applied = await result(a, 'hello', 'low')
    assert.equal(applied.find((e) => e.type === 'effort').effort, 'low')
    assert.equal(applied.find((e) => e.type === 'text').text, 'ok: hello')
    assert.equal(
      (await result(b, 'independent')).some((e) => e.type === 'effort'),
      false,
    )
    const reset = await result(a, 'ask-claude-perm')
    assert.equal(reset.find((e) => e.type === 'effort').effort, 'high')
    assert.equal(reset.find((e) => e.type === 'permission').action, 'Run Bash')
    assert.match(reset.find((e) => e.type === 'text').text, /deny/)
    await assert.rejects(result(a, 'not submitted', 'impossible'), /not supported/)
  },
)
