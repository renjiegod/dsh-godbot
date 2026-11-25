import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTLED_TOOL_TURNS, executionTools } from '../../src/client/execution-tools.js'

// Reads of one render go out together on the next timer tick.
const settle = () => new Promise(resolve => setTimeout(resolve, 5))
// A host that reads several turns at once unless `single` says it predates that.
const client = (answer, { single = false } = {}) => {
  const reads = []
  return { reads, dispatch: async (request) => {
    if (request.turns === undefined) { reads.push(request.turn); return answer(request) }
    reads.push('turns:' + request.turns.join(','))
    if (single) return answer({ ...request, turn: undefined })
    return { byTurn: Object.fromEntries(request.turns.map(turn => [turn, answer({ ...request, turn })])) }
  } }
}

test('going back to a chat draws its settled turns without asking the host again', async () => {
  const host = client(({ turn }) => ({ running: false, events: [{ id: `call-${turn}`, status: 'completed' }] }))
  const first = executionTools(host, 'b1', 'chat-1', 1)
  const leave = first.subscribe(() => {})
  await settle()
  assert.deepEqual(first.read().map(event => event.id), ['call-1'])
  leave()
  const again = executionTools(host, 'b1', 'chat-1', 1)
  again.subscribe(() => {})()
  await settle()
  assert.equal(again, first)
  assert.deepEqual(again.read().map(event => event.id), ['call-1'])
  assert.deepEqual(host.reads, [1])
})

test('a running turn and an empty answer are read again on the next visit', async () => {
  let running = true
  const host = client(({ turn }) => (turn === 1
    ? { running, events: [{ id: 'call-1', status: running ? 'running' : 'completed' }] }
    : { running: false, events: [] }))
  executionTools(host, 'b1', 'chat-1', 1).subscribe(() => {})()
  executionTools(host, 'b1', 'chat-1', 2).subscribe(() => {})()
  await settle()
  running = false
  const one = executionTools(host, 'b1', 'chat-1', 1)
  const leave = one.subscribe(() => {})
  executionTools(host, 'b1', 'chat-1', 2).subscribe(() => {})()
  await settle()
  leave()
  assert.deepEqual(host.reads, ['turns:1,2', 'turns:1,2'])
  assert.equal(one.read()[0].status, 'completed')
})

test('only the newest settled turns no cell shows are kept', async () => {
  const host = client(({ turn }) => ({ running: false, events: [{ id: `call-${turn}` }] }))
  const shown = executionTools(host, 'b1', 'chat-1', 0)
  shown.subscribe(() => {})
  for (let turn = 1; turn <= SETTLED_TOOL_TURNS + 5; turn++) {
    const leave = executionTools(host, 'b1', 'chat-1', turn).subscribe(() => {})
    await settle()
    leave()
  }
  const reads = host.reads.length
  executionTools(host, 'b1', 'chat-1', SETTLED_TOOL_TURNS + 5).subscribe(() => {})()
  assert.equal(executionTools(host, 'b1', 'chat-1', 0), shown, 'a shown turn is never dropped')
  await settle()
  assert.equal(host.reads.length, reads, 'the newest left turn is still kept')
  executionTools(host, 'b1', 'chat-1', 1).subscribe(() => {})()
  await settle()
  assert.equal(host.reads.length, reads + 1, 'the oldest left turn was dropped and is read again')
})

test('a running turn that answers the same again draws nothing new and is read more slowly', async () => {
  const { toolPollDelay } = await import('../../src/client/execution-tools.js')
  assert.deepEqual([0, 1, 2, 5].map(quiet => toolPollDelay(quiet, false)), [700, 1400, 2800, 2800])
  assert.equal(toolPollDelay(0, true), 5000)
  let answer = { running: true, events: [{ id: 'call-1', status: 'running' }] }
  const host = client(() => answer)
  const store = executionTools(host, 'b1', 'chat-9', 1)
  let draws = 0
  const leave = store.subscribe(() => { draws += 1 })
  await settle()
  const first = store.read()
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(host.reads.length, 2)
  assert.equal(draws, 1, 'the same answer is not drawn again')
  assert.equal(store.read(), first)
  answer = { running: false, events: [{ id: 'call-1', status: 'completed' }] }
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(draws, 2)
  assert.equal(store.read()[0].status, 'completed')
  leave()
})

test('the turns one render draws are read in one request, or one by one from an older host', async () => {
  for (const single of [false, true]) {
    const host = client(({ turn }) => (turn === undefined ? { running: false, events: [] } : { running: false, events: [{ id: `call-${turn}` }] }), { single })
    const stores = [1, 2, 3].map(turn => executionTools(host, 'b9', 'chat-' + single, turn))
    const leaves = stores.map(store => store.subscribe(() => {}))
    await settle()
    assert.deepEqual(stores.map(store => store.read()[0]?.id), ['call-1', 'call-2', 'call-3'])
    assert.deepEqual(host.reads, single ? ['turns:1,2,3', 1, 2, 3] : ['turns:1,2,3'])
    leaves.forEach(leave => leave())
    const again = [4, 5].map(turn => executionTools(host, 'b9', 'chat-' + single, turn).subscribe(() => {}))
    await settle()
    assert.deepEqual(host.reads.slice(single ? 4 : 1), single ? [4, 5] : ['turns:4,5'], 'an older host is not asked for several again')
    again.forEach(leave => leave())
  }
})
