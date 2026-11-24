import test from 'node:test'
import assert from 'node:assert/strict'
import { batchedGroupRows } from '../../src/client/team-ui/group-rows.js'

const host = (answer) => {
  const calls = []
  const call = async (endpoint, payload) => { calls.push([endpoint, payload]); return answer(endpoint, payload) }
  return { calls, call }
}
const view = range => ({ rows: [{ text: `${range.from}-${range.to ?? 'open'}` }], open: range.to === undefined })

test('the rows one render asks for go to the host in one request per group', async () => {
  const h = host((endpoint, payload) => (endpoint === 'group-rows-many' ? payload.ranges.map(view) : view(payload)))
  const rows = batchedGroupRows(h.call)
  const answers = await Promise.all([
    rows('room-1', 1, 4, 'a1'), rows('room-1', 5, 9, 'a2'), rows('room-1', 1, 4, 'a1'), rows('room-1', 10), rows('room-2', 3, 7),
  ])
  assert.deepEqual(answers.map(answer => answer.rows[0].text), ['1-4', '5-9', '1-4', '10-open', '3-7'])
  assert.deepEqual(h.calls, [
    ['group-rows-many', { roomId: 'room-1', ranges: [{ from: 1, to: 4, anchor: 'a1' }, { from: 5, to: 9, anchor: 'a2' }, { from: 10 }] }],
    ['group-rows', { roomId: 'room-2', from: 3, to: 7 }],
  ])
  await rows('room-1', 1, 4, 'a1')
  assert.equal(h.calls.length, 3, 'a later render asks again')
})

test('a host without the batch reads one range per request from then on', async () => {
  const h = host((endpoint, payload) => {
    if (endpoint === 'group-rows-many') throw Object.assign(new Error('Unknown endpoint group-rows-many'), { code: 'bot/not-found' })
    return view(payload)
  })
  const rows = batchedGroupRows(h.call)
  const answers = await Promise.all([rows('room-1', 1, 4), rows('room-1', 5, 9)])
  assert.deepEqual(answers.map(answer => answer.rows[0].text), ['1-4', '5-9'])
  await Promise.all([rows('room-1', 1, 4), rows('room-1', 5, 9)])
  assert.deepEqual(h.calls.map(([endpoint]) => endpoint), ['group-rows-many', 'group-rows', 'group-rows', 'group-rows', 'group-rows'])
})

test('a failed read answers null, as the cell expects', async () => {
  const h = host(() => { throw Object.assign(new Error('offline'), { code: 'NETWORK' }) })
  const rows = batchedGroupRows(h.call)
  assert.deepEqual(await Promise.all([rows('room-1', 1, 4), rows('room-1', 5)]), [null, null])
  assert.equal(await rows('room-1', 6), null)
})
