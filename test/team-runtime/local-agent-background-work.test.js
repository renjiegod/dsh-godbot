import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ClaudeEngine } from '../../src/drivers/external/claude.js'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'

// A part whose Claude Code still works after its turn ended (a background task, or the
// answer it gives by itself once the task ends) is not idle: switching away from it or
// starting a New session must not archive it or close its CLI (parts.js).
const fixture = fileURLToPath(new URL('../external/fixtures/fake-claude-turns.mjs', import.meta.url))
const route = 'local-claude-code'
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

const engines = {
  host: (id, spec) => createWorkspaceClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
  sandbox: (id, spec) => new ClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
}

function adapterFor(engine, deps = {}) {
  const records = {}
  return new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => tmpdir(),
    presetFor: () => 'danger-full-access', toolsFor: () => [],
    record: id => records[id], saveRecord: (id, row) => { records[id] = row }, patchRecord: () => {},
    spawnEngine: (_kind, id, spec) => engines[engine](id, spec),
    idleCloseMs: 60_000, backgroundIdleCloseMs: 60_000,
    ...deps,
  })
}

async function ask(adapter, text) {
  const chunks = await Array.fromAsync(adapter.stream({
    provider: route, model: 'default', sessionId: 'part', messages: [user('u1', text)], signal: AbortSignal.timeout(10_000),
  }))
  assert.equal(textOf(chunks), 'started a background task')
}

async function until(check, why, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await delay(25)
  }
  assert.fail('Timed out waiting for ' + why)
}

describe('a CLI that still works after its turn', { concurrency: true }, () => {
  for (const engine of Object.keys(engines)) {
    describe(`${engine} Claude Code`, { concurrency: true }, () => {
      test('its part works while a background task runs, and stops once the task ended', { timeout: 15000 }, async (t) => {
        const adapter = adapterFor(engine)
        t.after(() => adapter.dispose())
        assert.equal(adapter.backgroundWork('part'), false, 'a part with no CLI yet')
        await ask(adapter, 'TASK 1200')
        assert.equal(adapter.backgroundWork('part'), true, 'the turn ended with its task still running')
        assert.equal(adapter.backgroundWork('elsewhere'), false)
        // No Session shows what the CLI says by itself here, so the task's end is all.
        await until(() => !adapter.backgroundWork('part'), 'the task to end')
      })

      test('a reply the CLI gives by itself keeps its part working until its Session shows it', { timeout: 15000 }, async (t) => {
        const opened = []
        const adapter = adapterFor(engine, { onBackground: (sessionId, id) => { opened.push({ sessionId, id }); return true } })
        t.after(() => adapter.dispose())
        await ask(adapter, 'TASK 300')
        await until(() => opened.length > 0, 'the CLI to answer by itself')
        assert.equal(opened[0].sessionId, 'part')
        await delay(200)
        assert.equal(adapter.backgroundWork('part'), true, 'the answer waits for a turn of its Session to show it')
      })

      test('a reply no Session takes is dropped and keeps nothing working', { timeout: 15000 }, async (t) => {
        let refused = 0
        const adapter = adapterFor(engine, { onBackground: () => { refused += 1; return false } })
        t.after(() => adapter.dispose())
        await ask(adapter, 'TASK 300')
        await until(() => refused > 0, 'the CLI to answer by itself')
        await until(() => !adapter.backgroundWork('part'), 'the refused answer to be dropped')
      })
    })
  }
})
