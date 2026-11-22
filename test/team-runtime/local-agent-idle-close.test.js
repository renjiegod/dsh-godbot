import assert from 'node:assert/strict'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ClaudeEngine } from '../../src/drivers/external/claude.js'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'

const fixture = fileURLToPath(new URL('../external/fixtures/fake-claude-turns.mjs', import.meta.url))
const route = 'local-claude-code'
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const running = child => child.exitCode === null && child.signalCode === null

// A Bot's Claude Code runs on the host (the workspace engine) or in a sandbox (the
// external driver's engine). Both tell the adapter about their background tasks.
const engines = {
  host: (id, spec) => createWorkspaceClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
  sandbox: (id, spec) => new ClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
}

function adapterFor(engine, limits) {
  const records = {}
  return new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => tmpdir(),
    presetFor: () => 'danger-full-access', toolsFor: () => [],
    record: id => records[id], saveRecord: (id, row) => { records[id] = row }, patchRecord: () => {},
    spawnEngine: (_kind, id, spec) => engines[engine](id, spec),
    ...limits,
  })
}

// One message to the Bot. Returns the CLI process that answered it, and `exit(ms)`:
// how long after the reply that process exited, or Infinity if it still runs `ms` after.
async function ask(adapter, text) {
  const chunks = await Array.fromAsync(adapter.stream({
    provider: route, model: 'default', sessionId: 'part', messages: [user('u1', text)], signal: AbortSignal.timeout(10_000),
  }))
  const since = performance.now()
  assert.equal(textOf(chunks), 'started a background task')
  const { child } = adapter.live.get('part').engineSession
  assert.ok(running(child))
  const exited = once(child, 'exit').then(() => performance.now() - since)
  const exit = ms => Promise.race([exited, delay(since + ms - performance.now(), Infinity, { ref: false })])
  return { child, exit }
}

describe('the idle close of a Claude Code process', { concurrency: true }, () => {
  for (const engine of Object.keys(engines)) {
    describe(`${engine} Claude Code`, { concurrency: true }, () => {
      test('a process outlasts the idle limit while a background task runs, and leaves a full idle limit after the task ends', { timeout: 15000 }, async (t) => {
        const adapter = adapterFor(engine, { idleCloseMs: 800, backgroundIdleCloseMs: 60_000 })
        t.after(() => adapter.dispose())
        const { child, exit } = await ask(adapter, 'TASK 1500')
        // Past the idle limit; the task runs until 1.5 s in.
        await delay(1300)
        assert.ok(running(child), 'the process was closed while its background task ran')
        assert.ok(adapter.live.has('part'))
        const closed = await exit(6000)
        assert.ok(closed >= 2000 && closed < 6000, `the process left ${Math.round(closed)} ms in`)
        assert.equal(adapter.live.has('part'), false)
      })

      test('a background task that never ends keeps the process only for the longer limit', { timeout: 15000 }, async (t) => {
        const adapter = adapterFor(engine, { idleCloseMs: 300, backgroundIdleCloseMs: 1500 })
        t.after(() => adapter.dispose())
        const { child, exit } = await ask(adapter, 'TASK')
        await delay(1000)
        assert.ok(running(child), 'the process was closed at the idle limit')
        const closed = await exit(4000)
        assert.ok(closed >= 1300 && closed < 4000, `the process left ${Math.round(closed)} ms in`)
      })

      test('tasks the CLI marks ambient or off-host do not keep the process', { timeout: 15000 }, async (t) => {
        const adapter = adapterFor(engine, { idleCloseMs: 300, backgroundIdleCloseMs: 60_000 })
        t.after(() => adapter.dispose())
        const { exit } = await ask(adapter, 'AMBIENT OFF_HOST')
        const closed = await exit(2000)
        assert.ok(closed < 2000, `the process left ${Math.round(closed)} ms in`)
      })

      test('leaving the Session or disposing of the adapter closes the process at once, background task or not', { timeout: 15000 }, async (t) => {
        const left = adapterFor(engine, { idleCloseMs: 60_000, backgroundIdleCloseMs: 60_000 })
        t.after(() => left.dispose())
        const session = await ask(left, 'TASK')
        await left.closeSession('part')
        assert.equal(left.live.has('part'), false)
        assert.ok(await session.exit(3000) < 3000)

        const disposed = adapterFor(engine, { idleCloseMs: 60_000, backgroundIdleCloseMs: 60_000 })
        const bot = await ask(disposed, 'TASK')
        await disposed.dispose()
        assert.ok(await bot.exit(3000) < 3000)
      })
    })
  }
})
