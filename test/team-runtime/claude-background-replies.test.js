import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ClaudeEngine } from '../../src/drivers/external/claude.js'
import { BotBudget } from '../../src/host/bot-budget.js'
import { BACKGROUND_NOTE } from '../../src/host/team-runtime/core/constants.js'
import { backgroundTrigger, LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { historyEntry } from '../../src/host/team-runtime/core/parts.js'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'

// The fake CLI answers "BACKGROUND" by starting a task that ends a moment later and wakes
// the model into a turn of its own, which says this.
const fixture = fileURLToPath(new URL('../external/fixtures/fake-claude-turns.mjs', import.meta.url))
const AUTONOMOUS = 'autonomous: the background task finished'
const route = 'local-claude-code'
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, text) => ({ role: 'assistant', id, content: [{ type: 'text', text }] })
// The message delivery.js opens a turn with to show what the CLI said by itself.
const trigger = (id, background) => ({
  role: 'user', id, content: [{ type: 'text', text: BACKGROUND_NOTE }],
  source: { kind: 'bot', form: 'background', role: 'background', background },
})
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const blockText = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')

// The two Claude engines a Bot runs on: the team's own and the one sandbox Bots use.
const engines = {
  team: (id, spec) => createWorkspaceClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
  sandbox: (id, spec) => new ClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
}

function setup(t, engineFor, limits = {}) {
  const records = {}
  // What reached the CLI as a prompt or a steer.
  const prompts = []
  // The turns the adapter asked the Session to open, as delivery.js would.
  const opened = []
  let notify
  const adapter = new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => tmpdir(),
    presetFor: () => 'danger-full-access', toolsFor: () => [],
    record: id => records[id], saveRecord: (id, row) => { records[id] = row }, patchRecord: () => {},
    onBackground: (sessionId, background) => {
      opened.push({ sessionId, background })
      notify?.()
      return true
    },
    spawnEngine: (_kind, id, spec) => {
      const engine = engineFor(id, spec)
      for (const name of ['prompt', 'steer']) {
        const original = engine[name].bind(engine)
        engine[name] = (session, input, ...rest) => {
          prompts.push(Array.isArray(input) ? blockText(input) : input)
          return original(session, input, ...rest)
        }
      }
      return engine
    },
    ...limits,
  })
  t.after(() => adapter.dispose())
  const opening = async (count) => {
    for (let wait = 0; opened.length < count && wait < 200; wait++) await new Promise(resolve => { notify = resolve; setTimeout(resolve, 25) })
    assert.ok(opened.length >= count, 'the adapter asked for a turn to show what the CLI said by itself')
    return opened[count - 1]
  }
  const options = { provider: route, model: 'default', sessionId: 'part' }
  const run = (messages, signal = AbortSignal.timeout(10_000)) => Array.fromAsync(adapter.stream({ ...options, messages, signal }))
  return { adapter, prompts, opened, opening, run, options }
}

for (const [name, engineFor] of Object.entries(engines)) {
  test(`${name} engine: what Claude says after its background task ends shows in a turn of its own, without a prompt to the CLI`, { timeout: 20_000 }, async (t) => {
    const { prompts, opened, opening, run } = setup(t, engineFor)
    const u1 = user('u1', 'BACKGROUND task')
    const first = await run([u1])
    assert.equal(textOf(first), 'started a background task')
    // A new CLI session gets the conversation so far, which ends with the message.
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /BACKGROUND task$/u)

    // The task ends and the model answers it by itself: the adapter asks for a turn.
    const { sessionId, background } = await opening(1)
    assert.equal(sessionId, 'part')
    const t1 = trigger('t1', background)
    const shown = await run([u1, assistant('a1', textOf(first)), t1])
    assert.equal(textOf(shown), AUTONOMOUS)
    assert.ok(shown.some(chunk => chunk.type === 'usage'), 'the turn carries the usage of what the CLI did')
    assert.deepEqual(shown.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    // Nothing went to the CLI for that turn, and it opened no other.
    assert.equal(prompts.length, 1)
    assert.equal(opened.length, 1)

    // The next message gets its own answer; the message that opened the turn never
    // reaches the CLI.
    const second = await run([u1, assistant('a1', textOf(first)), t1, assistant('a2', AUTONOMOUS), user('u2', 'next')])
    assert.equal(textOf(second), 'reply: next')
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1], 'next')
  })

  test(`${name} engine: a background turn that runs while the Session is busy shows after that turn, not in it`, { timeout: 20_000 }, async (t) => {
    const { prompts, opening, run } = setup(t, engineFor)
    const u1 = user('u1', 'BACKGROUND SLOW task')
    const first = await run([u1])
    const { background } = await opening(1)
    // The Session is busy with the user's next message while the CLI still answers its
    // task: the prompt waits behind that turn in the CLI, and the turn that shows it
    // runs after this one.
    const a1 = assistant('a1', textOf(first))
    const busy = await run([u1, a1, user('u2', 'next')])
    assert.equal(textOf(busy), 'reply: next')
    const shown = await run([u1, a1, user('u2', 'next'), assistant('a2', 'reply: next'), trigger('t1', background)])
    assert.equal(textOf(shown), AUTONOMOUS)
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1], 'next')
  })

  test(`${name} engine: the turn that shows what Claude says by itself streams it while Claude still speaks`, { timeout: 20_000 }, async (t) => {
    const { adapter, opening, run, options } = setup(t, engineFor)
    const u1 = user('u1', 'BACKGROUND SLOW task')
    const first = await run([u1])
    const { background } = await opening(1)
    const chunks = []
    let speaking
    for await (const chunk of adapter.stream({ ...options, messages: [u1, assistant('a1', textOf(first)), trigger('t1', background)], signal: AbortSignal.timeout(10_000) })) {
      if (chunk.type === 'text-delta' && speaking === undefined) speaking = adapter.live.get('part').background !== undefined
      chunks.push(chunk)
    }
    assert.equal(speaking, true, 'the first words show before the CLI ends its turn')
    assert.equal(textOf(chunks), AUTONOMOUS)
  })

  test(`${name} engine: what Claude still says by itself after the user stops that turn goes nowhere`, { timeout: 20_000 }, async (t) => {
    const { adapter, prompts, opening, run, options } = setup(t, engineFor)
    const u1 = user('u1', 'BACKGROUND SLOW task')
    const first = await run([u1])
    const { background } = await opening(1)
    const a1 = assistant('a1', textOf(first))
    const t1 = trigger('t1', background)
    const stop = new AbortController()
    const chunks = []
    for await (const chunk of adapter.stream({ ...options, messages: [u1, a1, t1], signal: stop.signal })) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') stop.abort()
    }
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
    assert.ok(textOf(chunks).length < AUTONOMOUS.length)
    // The fake CLI does not stop for an interrupt: the rest of that turn, and its end,
    // must not answer the next message.
    const next = await run([u1, a1, t1, assistant('a2', textOf(chunks)), user('u2', 'next')])
    assert.equal(textOf(next), 'reply: next')
    assert.equal(prompts.at(-1), 'next')
  })

  test(`${name} engine: a background task Claude Code reports opens one turn, for what Claude says when it ends`, { timeout: 20_000 }, async (t) => {
    const { opened, opening, run } = setup(t, engineFor)
    const u1 = user('u1', 'TASK 200 please')
    const first = await run([u1])
    assert.equal(textOf(first), 'started a background task')
    // The task list changed while the prompt ran, and nothing was said by itself yet.
    assert.equal(opened.length, 0)
    const { background } = await opening(1)
    const shown = await run([u1, assistant('a1', textOf(first)), trigger('t1', background)])
    assert.equal(textOf(shown), AUTONOMOUS)
    // The task list changing as the task ended opened nothing more.
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(opened.length, 1)
  })

  test(`${name} engine: a reply the Session has not shown yet keeps the process past the idle limit`, { timeout: 20_000 }, async (t) => {
    const { adapter, opening, run } = setup(t, engineFor, { idleCloseMs: 300, backgroundIdleCloseMs: 60_000 })
    const u1 = user('u1', 'BACKGROUND task')
    const first = await run([u1])
    const { background } = await opening(1)
    // The Session is busy elsewhere well past the idle limit.
    await new Promise(resolve => setTimeout(resolve, 900))
    assert.ok(adapter.live.has('part'), 'the process left with the reply it had not shown')
    const shown = await run([u1, assistant('a1', textOf(first)), trigger('t1', background)])
    assert.equal(textOf(shown), AUTONOMOUS)
    // Once shown, the process leaves at the idle limit as before.
    for (let wait = 0; adapter.live.has('part') && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(adapter.live.has('part'), false)
  })
}

test('a turn opened for what a CLI said by itself shows nothing once that CLI is gone', { timeout: 20_000 }, async (t) => {
  const { prompts, run } = setup(t, engines.team)
  const chunks = await run([user('u1', 'hello'), assistant('a1', 'hi'), trigger('t1', 'background-gone')])
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  assert.deepEqual(prompts, [])
})

test('only the last message from outside the loop opens a turn that shows what the CLI said by itself', () => {
  const t1 = trigger('t1', 'background-1')
  const context = { role: 'user', id: 'c1', content: [{ type: 'text', text: 'now' }], source: { kind: 'runtime-context' } }
  assert.equal(backgroundTrigger([user('u1', 'go'), t1]), t1)
  assert.equal(backgroundTrigger([user('u1', 'go'), t1, context]), t1)
  assert.equal(backgroundTrigger([t1, assistant('a1', 'done'), user('u2', 'next')]), undefined)
  assert.equal(backgroundTrigger([user('u1', 'go'), { ...t1, source: { ...t1.source, background: undefined } }]), undefined)
})

test('a handoff keeps what a Bot said by itself after a background task, not the note that opened that turn', () => {
  const event = { type: 'user/message', data: { content: [{ type: 'text', text: BACKGROUND_NOTE }], source: trigger('t1', 'b').source } }
  assert.deepEqual(historyEntry(event, false), { answer: false, who: 'bot', text: '', keepAnswers: true })
})

test('a Bot over its budget still shows what its CLI already said by itself', async () => {
  const rt = { isBotSession: id => id === 'part', selfOf: () => 'bot', roomOf: () => undefined }
  const store = { get: () => undefined, put: () => assert.fail('the turn was held for the budget'), update() {}, all: () => [] }
  const refusal = () => ({ limit: 'dailyTokens', resetsAt: Date.now() + 60_000 })
  const budget = new BotBudget({ store, clock: Date.now, service: { runtime: rt }, refusal }, { on() {} })
  budget.close()
  let admitted = false
  await budget.preStep({ agent: { id: 'part' }, step: 1, messages: [trigger('t1', 'background-1')] }, () => { admitted = true })
  assert.equal(admitted, true)
})
