// Opt-in. Uses two real model turns on the selected signed-in CLI, in a
// temporary empty workspace. Only allowlisted settings and outcomes are printed.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExternal } from '../../src/drivers/external/index.js'

const kind = process.argv[2]
if (!['claude', 'codex', 'antigravity'].includes(kind))
  throw new Error('Choose claude, codex, or antigravity')
const cwd = await mkdtemp(join(tmpdir(), 'godbot-live-effort-'))
let handle, turn, sessionId
const observed = {}
function onEvent(e) {
  if (e.type === 'session') sessionId = e.nativeId
  if (!turn || turn.id !== e.turnId) return
  if (e.type === 'text') turn.text += e.text
  if (e.type === 'error') turn.end.reject(new Error(e.text))
  if (e.type === 'done') turn.end.resolve(e.status)
  if (e.type === 'permission')
    void handle.respond({ requestId: e.requestId, decision: 'deny' }).catch(() => {})
}
async function nativeTurn() {
  const marker = 'GDB-' + randomUUID().slice(0, 8)
  turn = { id: randomUUID(), text: '', end: Promise.withResolvers() }
  let timer
  try {
    await handle.start({ turnId: turn.id, text: 'Reply with exactly ' + marker + '. Do not use tools.' })
    const terminal = await Promise.race([
      turn.end.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native turn timed out')), 90000)
      }),
    ])
    assert.equal(terminal, 'completed')
    assert.ok(turn.text.includes(marker))
  } finally {
    clearTimeout(timer)
    turn = undefined
  }
}

try {
  handle = await openExternal({ kind, cwd, onEvent })
  const first = await handle.describe()
  observed.baseline = { model: first.currentModel, effort: first.currentEffort }
  assert.ok(first.canSetEffort)
  const selected = first.efforts.find((e) => e.id !== first.currentEffort)?.id
  assert.ok(selected)
  const set = await handle.configure({ effort: selected })
  assert.equal(set.currentEffort, selected)
  observed.selected = { model: set.currentModel, effort: set.currentEffort, source: set.effortSource }
  await nativeTurn()
  const original = handle.nativeId ?? sessionId
  assert.ok(original)
  await handle.close()
  handle = await openExternal({
    kind,
    cwd,
    resumeId: original,
    config: { model: set.currentModel, effort: selected },
    onEvent,
  })
  const resumed = await handle.describe()
  assert.equal(resumed.currentEffort, selected)
  assert.equal(handle.nativeId, original)
  observed.sameIdResume = true
  observed.resumedEffort = resumed.currentEffort
  const reset = await handle.configure({ model: null, effort: null })
  observed.clearDefaults = { model: reset.currentModel, effort: reset.currentEffort }
  assert.equal(reset.currentModel, first.currentModel)
  assert.equal(reset.currentEffort, first.currentEffort)
  await nativeTurn()
  observed.realTurnsCompleted = 2
  console.log(JSON.stringify({ kind, ...observed }))
} catch (error) {
  console.error(JSON.stringify({ kind, ...observed, error: error.message }))
  process.exitCode = 1
} finally {
  await handle?.close().catch(() => {})
  await rm(cwd, { recursive: true, force: true })
}
