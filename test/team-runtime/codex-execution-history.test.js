import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceAgentAdapter } from '../../src/host/team-runtime/local-agents.js'

const binding = { route: 'local-codex-cli', cwd: join(tmpdir(), 'codex-bound-history'), cliSessionId: 'thread-bound' }
const output = { id: 'item-report', type: 'agentMessage', text: 'Fixture report' }

function fixture(reply) {
  const requests = []
  const peer = {
    async request(method, params) {
      requests.push([method, params])
      return reply(method, params)
    },
  }
  let closes = 0
  const engine = { ensure: async () => peer, close: async () => { closes++ } }
  const adapter = new WorkspaceAgentAdapter({ customAgents: () => [], spawnEngine: () => engine })
  return { adapter, requests, engine, closes: () => closes }
}

test('Codex history reads a bound legacy thread without opening or resuming it', async () => {
  const shell = { id: 'item-shell', type: 'commandExecution', status: 'failed', command: 'npm test',
    cwd: binding.cwd, aggregatedOutput: 'Fixture failed output', exitCode: 2, durationMs: 175 }
  const mock = fixture((method, params) => {
    assert.equal(method, 'thread/read')
    assert.equal(params.threadId, binding.cliSessionId)
    const turns = !params.includeTurns ? [] : [{ id: 'turn-one', status: 'completed', startedAt: 1790000000, completedAt: 1790000002,
      items: [{ id: 'item-input', type: 'userMessage', content: [{ type: 'text', text: 'Run a fixture.' }] }, shell, output] }]
    return { thread: { id: binding.cliSessionId, cwd: binding.cwd, turns } }
  })

  const [turn] = await mock.adapter.readCodexExecutionHistory(binding)
  assert.equal(turn.nativeTurnId, 'turn-one')
  assert.equal(turn.startedAt, new Date(1790000000 * 1000).toISOString())
  assert.equal(turn.endedAt, new Date(1790000002 * 1000).toISOString())
  assert.deepEqual(turn.events.map(event => event.type), ['input', 'tool', 'text'])
  assert.deepEqual(turn.events.map(event => event.seq), [1, 2, 3])
  assert.equal(turn.events[1].input, shell.command)
  assert.equal(turn.events[1].output, shell.aggregatedOutput)
  assert.equal(turn.events[1].exitCode, shell.exitCode)
  assert.equal(turn.events[2].text, output.text)
  assert.deepEqual(mock.requests.map(([, params]) => params.includeTurns), [undefined, true])
  assert.equal(mock.closes(), 1)
})

test('Codex history pages full retained turns and preserves a live app-server', async () => {
  const mock = fixture((method, params) => {
    assert.equal(params.threadId, binding.cliSessionId)
    if (method === 'thread/read') return { thread: { id: binding.cliSessionId, cwd: binding.cwd, historyMode: 'paginated' } }
    assert.equal(method, 'thread/turns/list')
    assert.equal(params.itemsView, 'full')
    assert.equal(params.sortDirection, 'desc')
    if (!params.cursor) return { nextCursor: 'earlier', data: [
      { id: 'active', status: 'inProgress', items: [{ ...output, text: 'Do not replay unfinished work' }] },
      { id: 'latest', status: 'completed', itemsView: 'full', items: [{ ...output, startedAtMs: 1790000000250, completedAtMs: 1790000000500 }] },
    ] }
    assert.equal(params.cursor, 'earlier')
    return { data: [{ id: 'older', status: 'completed', items: [{ ...output, text: 'Previous report' }] }] }
  })
  mock.adapter.live.set('running-part', { engine: mock.engine, dead: false })
  const turns = await mock.adapter.readCodexExecutionHistory(binding)
  assert.deepEqual(turns.map(turn => turn.nativeTurnId), ['older', 'latest'])
  assert.equal(turns[0].startedAt, '')
  assert.equal(turns[1].startedAt, new Date(1790000000250).toISOString())
  assert.equal(turns[1].endedAt, new Date(1790000000500).toISOString())
  assert.equal(mock.closes(), 0)
})

test('Codex history declines an unexpected thread identity or working directory', async () => {
  const wrongThread = fixture(() => ({ thread: { id: 'wrong-thread', cwd: binding.cwd } }))
  assert.deepEqual(await wrongThread.adapter.readCodexExecutionHistory(binding), [])
  assert.equal(wrongThread.requests.length, 1)

  const movedCwd = fixture((_method, params) => ({ thread: {
    id: binding.cliSessionId, cwd: params.includeTurns ? join(tmpdir(), 'another-workspace') : binding.cwd,
    turns: [{ id: 'wrong-turn', items: [output] }],
  } }))
  assert.deepEqual(await movedCwd.adapter.readCodexExecutionHistory(binding), [])
  assert.equal(movedCwd.requests.length, 2)
})

test('Codex delivery reconciliation requires the message marker in the exact native turn', async () => {
  const input = text => ({ type: 'userMessage', content: [{ type: 'text', text }] })
  const mock = fixture((_method, params) => ({ thread: {
    id: binding.cliSessionId, cwd: binding.cwd,
    turns: params.includeTurns ? [
      { id: 'other', status: 'completed', items: [input('[Godbot message ID: delivery-1]'), output] },
      { id: 'wanted', status: 'completed', items: [output, input('Request\n[Godbot message ID: delivery-10]'),
        input('Update\n[Godbot message ID: delivery-2]'), { ...output, text: 'The answer after the update.' }] },
    ] : [],
  } }))
  const exact = { ...binding, turnId: 'wanted' }
  assert.equal(await mock.adapter.readCodexInboxDelivery(exact, 'delivery-1'), undefined)
  assert.deepEqual(await mock.adapter.readCodexInboxDelivery(exact, 'delivery-2'), {
    turnId: 'wanted', status: 'completed', text: 'The answer after the update.',
  })
})
