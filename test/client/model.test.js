import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createClient,
  optionsOf,
  sendModes,
  timelineEntries,
  toolOutputText,
  pendingRequests,
  taskGuard,
} from '../../src/client/model.js'

test('reads the remote envelope and preserves the owner RPC argument shape', async () => {
  const requests = []
  const api = createClient({
    rpc: {
      async call(...args) {
        requests.push(args)
        return { ok: true, value: { id: 'receipt' } }
      },
    },
  })
  const draft = { action: 'member.stop', expectedTurnId: 'turn', memberId: 'member' }
  assert.deepEqual(await api.snapshot(), { id: 'receipt' })
  assert.deepEqual(await api.dispatch(draft), { id: 'receipt' })
  assert.deepEqual(requests, [
    ['/api', 'godbot/snapshot', { args: {} }],
    ['/api', 'godbot/dispatch', { args: { request: draft } }],
  ])
  const read = { terminalId: 'pty', cursor: 0, waitMs: 5000 }
  const { signal } = new AbortController()
  await api.terminalRead(read, signal)
  assert.deepEqual(requests.at(-1), ['/api', 'godbot/terminalRead', { args: { request: read } }, signal])
})

test('an unsuccessful envelope exposes the host error code and readable message', async () => {
  const api = createClient({
    rpc: { call: async () => ({ ok: false, error: { code: 'remote-access/denied', message: 'Owner required' } }) },
  })
  await assert.rejects(api.snapshot(), /remote-access\/denied.*Owner required/)
})

test('turn-dependent input choices track the selected member and current turn', () => {
  const choices = (options) => sendModes(options).map((mode) => mode.value)
  const member = { capabilities: { steer: true, interrupt: true }, activeTurnId: null }
  assert.deepEqual(choices(member), ['queue'])
  assert.deepEqual(choices({ ...member, activeTurnId: 'current' }), ['queue', 'steer', 'interrupt-send'])
  assert.deepEqual(choices({ activeTurnId: 'acp', capabilities: { interrupt: true } }), [
    'queue',
    'interrupt-send',
  ])
})

test('native approval choices preserve their IDs while question choices can carry plain labels', () => {
  assert.deepEqual(
    optionsOf([
      { optionId: 'approve-session', name: 'Allow this session' },
      { label: 'Use defaults' },
      'Cancel',
      { kind: 'unknown' },
    ]),
    [
      { value: 'approve-session', label: 'Allow this session' },
      { value: 'Use defaults', label: 'Use defaults' },
      { value: 'Cancel', label: 'Cancel' },
    ],
  )
})

test('one streamed reply reads continuously without merging across tools or turns', () => {
  const input = [
    { id: 'a', type: 'text', text: 'one', turnId: 'first' },
    { id: 'b', type: 'text', text: ' two', turnId: 'first' },
    { id: 'tool', type: 'tool', name: 'read', turnId: 'first' },
    { id: 'c', type: 'text', text: 'after', turnId: 'first' },
    { id: 'd', type: 'text', text: 'again', turnId: 'second' },
  ]
  const entries = timelineEntries(input)
  assert.deepEqual(
    entries.map((event) => event.id),
    ['a', 'tool', 'c', 'd'],
  )
  assert.equal(entries[0].text, 'one two')
  assert.equal(input[0].text, 'one')
})

test('tool output survives a separate summary and displays native text blocks', () => {
  assert.equal(toolOutputText({ text: 'Read fixture', output: 'fixture body' }), 'fixture body')
  assert.equal(toolOutputText({ text: 'Run fixture', content: [
    { type: 'content', content: { type: 'text', text: 'ACP result' } },
    { type: 'text', text: 'DSH result' },
  ] }), 'ACP result\nDSH result')
  assert.equal(toolOutputText({ output: 'raw receipt', content: [
    { type: 'text', text: 'separate content' },
    { type: 'image', mimeType: 'image/png', data: 'binary data' },
  ] }), 'raw receipt\nseparate content\nimage/png')
  assert.equal(toolOutputText({ output: 'duplicate', content: [{ type: 'text', text: 'duplicate' }] }), 'duplicate')
  assert.equal(toolOutputText({ text: 'Only a summary' }), '')
})

test('a lost response can be retried after remount with the same opaque ID, without persisting the prompt', async () => {
  const saved = new Map()
  const storage = {
    getItem: (key) => saved.get(key),
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  }
  const request = {
    action: 'member.send',
    memberId: 'worker',
    text: 'private user content',
    mode: 'steer',
    expectedTurnId: 'run1',
  }
  const original = await pendingRequests(storage).begin(request)
  const remounted = pendingRequests(storage)
  const reordered = Object.fromEntries(Object.entries(request).reverse())
  const replay = await remounted.begin(reordered)
  assert.deepEqual(original, replay)
  assert.equal(JSON.stringify([...saved]).includes(request.text), false)
  assert.notEqual((await remounted.begin({ ...request, expectedTurnId: 'run2' })).id, original.id)
  remounted.complete(replay)
  assert.notEqual((await remounted.begin(request)).id, original.id)
})

test('a quality operation captures the owner and revision visible when the form was opened', () => {
  const task = { id: 'task', ownerId: 'builder', revision: 4 }
  const original = taskGuard(task)
  task.revision++
  task.ownerId = 'reviewer'
  assert.deepEqual(original, { taskId: 'task', expectedOwnerId: 'builder', expectedRevision: 4 })
})

test('polls request only new events, retain histories and detect a stale cursor or host change', async () => {
  const { mergeSnapshot, nextEventCursor } = await import('../../src/client/model.js')
  const calls = []
  await createClient({
    rpc: {
      call: async (...args) => {
        calls.push(args)
        return { ok: true, value: {} }
      },
    },
  }).snapshot({ afterEventSeq: 7, eventStreamId: 'h' })
  assert.deepEqual(calls, [['/api', 'godbot/snapshot', { args: { afterEventSeq: 7, eventStreamId: 'h' } }]])
  const before = { events: [{ seq: 3 }], eventAfter: null, lastEventSeq: 3, eventStreamId: 'old', teams: [] }
  assert.deepEqual(nextEventCursor(before), { afterEventSeq: 3, eventStreamId: 'old' })
  const after = {
    events: [{ seq: 7 }],
    eventAfter: 3,
    lastEventSeq: 7,
    eventStreamId: 'old',
    teams: [{ id: 't' }],
  }
  assert.deepEqual(mergeSnapshot(before, after).events, [{ seq: 3 }, { seq: 7 }])
  assert.equal(before.events.length, 1)
  assert.equal(mergeSnapshot(before, { ...after, eventStreamId: 'other' }), null)
  assert.equal(mergeSnapshot(before, { ...after, eventAfter: 4 }), null)
  const reset = { ...after, eventStreamId: 'new', eventAfter: null }
  assert.equal(mergeSnapshot(before, reset), reset)
  assert.equal(nextEventCursor({ events: [], teams: [] }), undefined)
})

test('long multi-line task evidence has a compact summary and retains its full source for expansion', async () => {
  const { evidenceSummary } = await import('../../src/client/model.js')
  const proof = 'Result of a long operation\n'.repeat(30).trimEnd()
  const preview = evidenceSummary(proof)
  assert.ok(preview.expandable)
  assert.ok(preview.summary.length < 100)
  assert.equal(preview.full, proof)
  assert.deepEqual(evidenceSummary('3 checks passed.'), {
    full: '3 checks passed.',
    summary: '3 checks passed.',
    expandable: false,
  })
})
