import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readClaudeExecutionHistory } from '../../src/host/team-runtime/claude-execution-history.js'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'godbot-claude-execution-history-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const configDir = join(root, 'claude-config')
  const nativeId = randomUUID()
  const folder = join(configDir, 'projects', cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-'))
  const path = join(folder, nativeId + '.jsonl')
  await Promise.all([mkdir(cwd), mkdir(folder, { recursive: true })])
  const rows = []
  const record = (type, content, details = {}) => ({
    type, cwd, sessionId: nativeId, uuid: randomUUID(),
    timestamp: new Date(1700000000000 + rows.length * 1000).toISOString(),
    message: { role: type, content }, ...details,
  })
  const add = (...args) => {
    const row = record(...args)
    rows.push(row)
    return row
  }
  return {
    binding: { cwd, configDir, nativeId }, path, root, rows, add,
    write: () => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n{"type":'),
  }
}

test('read-only history retains delegated prompt, tool inputs and outcomes, diffs and the final report', async t => {
  const f = await fixture(t)
  const user = f.add('user', 'Implement the fixture')
  f.add('user', 'Injected context', { isMeta: true })
  const command = { command: 'npm run test:fixture', description: 'Run fixture tests' }
  const calls = [
    { type: 'tool_use', id: 'call-edit', name: 'Edit', input: { file_path: 'sample.txt', old_string: 'a', new_string: 'b' } },
    { type: 'tool_use', id: 'call-shell', name: 'Bash', input: command },
  ]
  const toolCwd = join(f.root, 'changed-workspace')
  const toolMessage = f.add('assistant', calls, { cwd: toolCwd })
  f.rows.push(toolMessage)
  f.add('assistant', calls)
  f.add('user', [{ type: 'tool_result', tool_use_id: 'foreign-call', content: 'must not join this turn' }])
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
  f.add('user', [{ type: 'tool_result', tool_use_id: 'call-edit', content: 'File updated' }],
    { toolUseResult: { filePath: 'sample.txt', structuredPatch: hunks } })
  const output = [{ type: 'tool_result', tool_use_id: 'call-shell', is_error: false, content: 'Command failed' }]
  f.add('user', output, { toolUseResult: { stdout: 'Two tests ran', stderr: 'One failure', exitCode: 1, durationMs: 750 } })
  f.add('user', output, { toolUseResult: { stdout: 'Duplicate context' } })
  f.add('assistant', [{ type: 'thinking', thinking: 'Private internal reasoning' }])
  f.add('assistant', [{ type: 'text', text: 'Other native session' }], { sessionId: randomUUID() })
  f.add('assistant', [{ type: 'text', text: 'Not a main-session report' }], { isSidechain: true })
  const report = [{ type: 'text', text: 'Report: updated sample.txt, one fixture test failed.' }]
  const reply = f.add('assistant', report, { message: { role: 'assistant', content: report, stop_reason: 'end_turn' } })
  const followup = f.add('user', [{ type: 'text', text: 'Follow up' }])
  await f.write()

  const history = await readClaudeExecutionHistory(f.binding)
  assert.deepEqual(history, [{
    nativeTurnId: user.uuid, startedAt: user.timestamp, endedAt: reply.timestamp, events: [
      { seq: 1, type: 'input', text: 'Implement the fixture' },
      { seq: 2, type: 'tool', id: 'call-edit', name: 'Edit', status: 'running', cwd: toolCwd, input: calls[0].input },
      { seq: 3, type: 'tool', id: 'call-shell', name: 'Bash', status: 'running', cwd: toolCwd, input: command },
      { seq: 4, type: 'tool', id: 'call-edit', name: 'Edit', status: 'completed', output: 'File updated', changes: [{ path: 'sample.txt', hunks }] },
      { seq: 5, type: 'tool', id: 'call-shell', name: 'Bash', status: 'failed', output: { stdout: 'Two tests ran', stderr: 'One failure' }, exitCode: 1, durationMs: 750 },
      { seq: 6, type: 'text', text: report[0].text },
    ],
  }, { nativeTurnId: followup.uuid, startedAt: followup.timestamp, events: [{ seq: 7, type: 'input', text: 'Follow up' }] }])
})

test('a result appended after the next prompt remains attached to its native call', async t => {
  const f = await fixture(t)
  f.add('user', 'Start a background command')
  f.add('assistant', [{ type: 'tool_use', id: 'background', name: 'Bash', input: { command: 'sleep 1' } }])
  f.add('user', 'Next prompt')
  f.add('user', [{ type: 'tool_result', tool_use_id: 'background', content: 'Native output' }])
  await f.write()
  const [first, second] = await readClaudeExecutionHistory(f.binding)
  assert.equal(first.events.at(-1).output, 'Native output')
  assert.deepEqual(second.events, [{ seq: 3, type: 'input', text: 'Next prompt' }])
})

test('history lookup uses only the authorized project and native UUID', async t => {
  const f = await fixture(t)
  const wrong = join(f.root, 'different-workspace')
  await mkdir(wrong)
  f.add('user', 'Bound session input')
  await f.write()
  assert.deepEqual(await readClaudeExecutionHistory({ ...f.binding, cwd: wrong }), [])
  assert.deepEqual(await readClaudeExecutionHistory({ ...f.binding, nativeId: randomUUID() }), [])
  assert.deepEqual(await readClaudeExecutionHistory({ ...f.binding, nativeId: '../arbitrary' }), [])
  if (process.platform !== 'win32') {
    const target = join(f.root, 'renamed.jsonl')
    await writeFile(target, JSON.stringify(f.rows[0]))
    await rm(f.path)
    await symlink(target, f.path)
    assert.deepEqual(await readClaudeExecutionHistory(f.binding), [])
  }
})
