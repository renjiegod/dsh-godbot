import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimComputerInput } from '../../src/host/computer-input-lock.js'
import { MachineSessions } from '../../computer-host/sessions.js'

test('private settings wait for capture to close and block fresh media until the owner exits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-privacy-test-'))
  const lock = (kind) => claimComputerInput(kind, dir)
  const capture = lock('capture')
  assert.throws(() => lock('private'), { code: 'BUSY' })
  capture()
  const settings = lock('private')
  assert.throws(() => lock('capture'), { code: 'BUSY' })
  assert.throws(() => lock('bot'), { code: 'BUSY' })
  settings()
  let privateView = false,
    finishClose
  const closed = new Promise((resolve) => {
    finishClose = resolve
  })
  let quality
  const host = new MachineSessions({
    desktop: {
      probe: async () => ({ available: true, control: true }),
      displays: async () => [{ id: 'main', name: 'display', width: 640, height: 480, revision: 1 }],
      start: async (config) => {
        quality = config.quality
        return { signal: async () => {}, close: () => closed }
      },
    },
    name: 'target',
    localPrivate: () => privateView,
    grants: () => ['desktop.view'],
    audit() {},
    claimInput: lock,
  })
  t.after(async () => {
    finishClose()
    await host.stop()
    await rm(dir, { recursive: true, force: true })
  })
  const peer = { deviceId: 'peer', tunnelId: 'tunnel', signal: new AbortController().signal }
  const rpc = (method, p) => host.call(method, p, peer)
  const s = await rpc('session.open', { mode: 'desktop', requestId: 'one' })
  const p = {
    sessionId: s.sessionId,
    displayId: 'main',
    generation: 1,
    signal: { type: 'offer', sdp: 'test offer' },
  }
  await assert.rejects(rpc('desktop.signal', { ...p, quality: 'unknown' }), { code: 'INVALID_PARAMS' })
  await rpc('desktop.signal', { ...p, quality: 'low' })
  assert.equal(quality, 'low')
  privateView = true
  let ready = false
  const protect = host.protectLocal().then(() => {
    ready = true
  })
  await Promise.resolve()
  assert.equal(ready, false)
  await assert.rejects(rpc('session.open', { mode: 'desktop', requestId: 'two' }), {
    code: 'LOCAL_MANAGEMENT_ACTIVE',
  })
  finishClose()
  await protect
  assert.equal((await rpc('session.status', { sessionId: s.sessionId })).state, 'closed')
  privateView = false
  assert.equal((await rpc('session.open', { mode: 'desktop', requestId: 'three' })).state, 'approved')
})

test('status traffic alone cannot keep a foreground input lease alive', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 })
  const host = new MachineSessions({
    desktop: {},
    name: 'target',
    grants: () => ['terminal'],
    audit() {},
  })
  t.after(() => host.stop())
  const peer = { deviceId: 'peer', tunnelId: 'one', signal: new AbortController().signal }
  const session = await host.call('session.open', { mode: 'terminal', requestId: 'one' }, peer)
  const p = { sessionId: session.sessionId }
  t.mock.timers.tick(3000)
  assert.equal((await host.call('session.status', p, peer)).state, 'approved')
  t.mock.timers.tick(2001)
  assert.equal((await host.call('session.status', p, peer)).reason, 'expired')
  assert.equal((await host.call('session.renew', p, peer)).state, 'closed')
})
