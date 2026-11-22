import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'

const fixture = fileURLToPath(new URL('../external/fixtures/fake-claude-turns.mjs', import.meta.url))
const route = 'local-claude-code'
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const assistant = (id, text) => ({ role: 'assistant', id, content: [{ type: 'text', text }] })
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

function adapterFor(records) {
  return new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => tmpdir(),
    presetFor: () => 'danger-full-access', toolsFor: () => [],
    record: id => records[id], saveRecord: (id, row) => { records[id] = row }, patchRecord: () => {},
    spawnEngine: (_kind, id, spec) => createWorkspaceClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
  })
}

test('a Bot reply arrives although the resumed Claude CLI first ends a turn for a task its last process left running', { timeout: 15000 }, async (t) => {
  // The Bot's CLI process was closed while a Monitor ran; the next message resumes it.
  const records = { part: { route, cliSessionId: `orphan-${randomUUID()}`, cwd: tmpdir() } }
  const adapter = adapterFor(records)
  t.after(() => adapter.dispose())
  const chunks = await Array.fromAsync(adapter.stream({
    provider: route, model: 'default', sessionId: 'part', messages: [user('u1', 'how much longer')], signal: AbortSignal.timeout(10_000),
  }))
  assert.match(textOf(chunks), /^reply: .*how much longer$/u)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('what Claude says in a turn of its own between two messages is not read as the reply to the second', { timeout: 15000 }, async (t) => {
  const records = {}
  const adapter = adapterFor(records)
  t.after(() => adapter.dispose())
  const options = { provider: route, model: 'default', sessionId: 'part', signal: AbortSignal.timeout(10_000) }
  const first = await Array.fromAsync(adapter.stream({ ...options, messages: [user('u1', 'BACKGROUND task')] }))
  assert.match(textOf(first), /started a background task/u)
  // The background task ends and the CLI answers it on its own before the next message.
  await new Promise(resolve => setTimeout(resolve, 300))
  const second = await Array.fromAsync(adapter.stream({
    ...options, messages: [user('u1', 'BACKGROUND task'), assistant('a1', textOf(first)), user('u2', 'next')],
  }))
  assert.equal(textOf(second), 'reply: next')
  const third = await Array.fromAsync(adapter.stream({
    ...options, messages: [user('u1', 'BACKGROUND task'), assistant('a1', textOf(first)), user('u2', 'next'), assistant('a2', 'reply: next'), user('u3', 'and again')],
  }))
  assert.equal(textOf(third), 'reply: and again')
})
