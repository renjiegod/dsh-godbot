import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { CodexEngine } from '../../src/host/team-runtime/core/local-agents/codex.js'

// Codex runs one app-server for all the Bots on a route, and a thread it still has
// loaded keeps the MCP server, model and permissions it was loaded with: a resume does
// not change them (Codex 0.172, which the fixture plays with --keep-loaded). A Session
// Godbot closes while another one keeps the process must come back with its own.
const fixture = fileURLToPath(new URL('../external/fixtures/fake-codex.mjs', import.meta.url))
const route = 'local-codex-cli'
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const said = (id, text) => ({ role: 'assistant', id, content: [{ type: 'text', text }] })
const methods = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line).method)

function codexAdapter(presets = {}) {
  const recordPath = join(mkdtempSync(join(tmpdir(), 'godbot-codex-release-')), 'record.jsonl')
  const saved = {}
  const adapter = new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => tmpdir(),
    presetFor: id => presets[id] ?? 'danger-full-access', toolsFor: () => [],
    record: id => saved[id], saveRecord: (id, row) => { saved[id] = row }, patchRecord: () => {},
    spawnEngine: (_kind, id, spec) => new CodexEngine(id, { ...spec, args: [fixture, '--record', recordPath, '--keep-loaded'] }, { findExecutable: () => process.execPath }),
  })
  return { adapter, recordPath }
}

const ask = (adapter, sessionId, messages) => Array.fromAsync(adapter.stream({
  provider: route, model: 'default', sessionId, messages, signal: AbortSignal.timeout(10_000),
}))
const first = [user('u1', 'hello')]
const second = [user('u1', 'hello'), said('a1', 'done'), user('u2', 'again')]

// What the app-server has a Session's thread bound to, and the sandbox it runs it in.
async function loadedWith(adapter, sessionId) {
  const peer = adapter.engine(route).peer
  const threadId = adapter.live.get(sessionId).cliSessionId
  const { data } = await peer.request('mcpServerStatus/list', { threadId }, { timeout: 5000 })
  const resumed = await peer.request('thread/resume', { threadId, cwd: tmpdir() }, { timeout: 5000 })
  return { origin: data.find(server => server.name === 'godbot')?.httpOrigin, sandbox: resumed.sandbox.type }
}
const serving = (adapter, sessionId) => new URL(adapter.live.get(sessionId).mcp.url).origin

test('a Codex Session closed while another keeps the app-server comes back bound to its new loopback server', { timeout: 20_000 }, async t => {
  const { adapter, recordPath } = codexAdapter()
  t.after(() => adapter.dispose())
  await ask(adapter, 'other', first)
  await ask(adapter, 'part', first)
  const before = serving(adapter, 'part')
  assert.equal((await loadedWith(adapter, 'part')).origin, before)

  await adapter.closeSession('part')
  assert.ok(adapter.live.has('other'), 'the other Session keeps the process')
  await ask(adapter, 'part', second)
  const after = serving(adapter, 'part')
  assert.notEqual(after, before, 'the closed server is not used again')
  assert.equal((await loadedWith(adapter, 'part')).origin, after, 'Godbot tools reach the server the Session serves')
  const calls = methods(recordPath)
  assert.ok(calls.indexOf('thread/unsubscribe') !== -1 && calls.indexOf('thread/unsubscribe') < calls.lastIndexOf('thread/resume'))
})

test('a Codex Session reopened with tighter permissions while another keeps the app-server runs with them', { timeout: 20_000 }, async t => {
  const presets = { part: 'danger-full-access' }
  const { adapter } = codexAdapter(presets)
  t.after(() => adapter.dispose())
  await ask(adapter, 'other', first)
  await ask(adapter, 'part', first)
  assert.equal((await loadedWith(adapter, 'part')).sandbox, 'workspaceWrite')

  presets.part = 'read-only'
  await ask(adapter, 'part', second)
  const loaded = await loadedWith(adapter, 'part')
  assert.equal(loaded.sandbox, 'readOnly', 'the new permissions apply, not the ones the thread was loaded with')
  assert.equal(loaded.origin, serving(adapter, 'part'))
})

test('a Codex Session closed with the last one on the app-server needs no release: the process leaves', { timeout: 20_000 }, async t => {
  const { adapter, recordPath } = codexAdapter()
  t.after(() => adapter.dispose())
  await ask(adapter, 'part', first)
  await adapter.closeSession('part')
  await ask(adapter, 'part', second)
  assert.equal((await loadedWith(adapter, 'part')).origin, serving(adapter, 'part'))
  assert.equal(methods(recordPath).includes('thread/unsubscribe'), false)
})
