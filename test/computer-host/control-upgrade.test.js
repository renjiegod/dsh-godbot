import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { MachineSessions } from '../../computer-host/sessions.js'
import { claimComputerInput } from '../../src/host/computer-input-lock.js'

async function view(t, setControl) {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-control-'))
  const counts = { opens: 0, closes: 0 }
  const lock = (kind) => claimComputerInput(kind, dir)
  let emit
  const sessions = new MachineSessions({
    name: 'Wayland',
    audit() {},
    claimInput: lock,
    grants: () => ['desktop.view', 'desktop.control'],
    desktop: {
      probe: async () => ({ available: true, control: true }),
      displays: async () => [{ id: 'main' }],
      start: async (opts) => {
        counts.opens++
        emit = opts.onSignal
        return {
          signal: async () => {},
          setControl,
          close: async () => {
            counts.closes++
          },
        }
      },
    },
  })
  t.after(async () => {
    await sessions.stop()
    await rm(dir, { recursive: true, force: true })
  })
  const peer = { deviceId: 'controller', tunnelId: 'one', signal: new AbortController().signal }
  const s = await sessions.call('session.open', { mode: 'desktop', requestId: 'view' }, peer)
  const call = (method, params = {}) => sessions.call(method, { sessionId: s.sessionId, ...params }, peer)
  await call('desktop.signal', { displayId: 'main', generation: 1, signal: { type: 'offer', sdp: 'test' } })
  return { call, counts, lock, emit }
}

test(
  'a compositor can take over 30 seconds to decline control without interrupting approved video',
  { timeout: 3000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 })
    const chooser = Promise.withResolvers()
    const { call, counts, lock, emit } = await view(t, (enabled) =>
      enabled ? chooser.promise : Promise.resolve(),
    )
    const pending = await call('desktop.requestControl')
    assert.equal(pending.state, 'approved')
    assert.equal(pending.control, false)
    assert.equal(pending.controlPrompt, 'system')
    assert.equal(pending.controlPending, true)
    assert.throws(() => lock('bot'), { code: 'BUSY' })
    for (let elapsed = 0; elapsed < 60000; elapsed += 1500) {
      t.mock.timers.tick(1500)
      const status = await call('session.renew')
      assert.equal(status.controlPending, true)
      assert.equal(status.control, false)
    }
    chooser.reject(Object.assign(new Error('Input declined by the target'), { code: 'INPUT_DENIED' }))
    await nextTurn()
    const status = await call('session.status')
    assert.equal(status.state, 'approved')
    assert.equal(status.control, false)
    assert.equal(status.controlPending, undefined)
    assert.equal(status.controlReason, 'INPUT_DENIED')
    assert.deepEqual(counts, { opens: 1, closes: 0 })
    lock('bot')()
    emit({ type: 'candidate', candidate: { candidate: 'still viewing' } })
    assert.equal(
      (await call('desktop.poll', { generation: 1, cursor: 0 })).signals[0].candidate.candidate,
      'still viewing',
    )
  },
)

test('release fences a chooser that grants input after cancellation', async (t) => {
  const chooser = Promise.withResolvers()
  const requests = []
  const { call, lock } = await view(t, (enabled) => {
    requests.push(enabled)
    return enabled ? chooser.promise : Promise.resolve()
  })
  assert.equal((await call('desktop.requestControl')).controlPending, true)
  await nextTurn()
  assert.equal((await call('desktop.releaseControl')).control, false)
  assert.deepEqual(requests, [true, false])
  chooser.resolve()
  await nextTurn()
  assert.equal((await call('session.status')).control, false)
  lock('bot')()
})

test('an unconfirmed input failure closes media and never reports a safe denial', async (t) => {
  const { call, counts, lock } = await view(t, async () => {
    throw Object.assign(new Error('Driver disconnected'), { code: 'DESKTOP_UNAVAILABLE' })
  })
  await call('desktop.requestControl')
  await nextTurn()
  const state = await call('session.status')
  assert.equal(state.state, 'closed')
  assert.equal(state.reason, 'input_failed')
  assert.equal(counts.closes, 1)
  lock('bot')()
})
