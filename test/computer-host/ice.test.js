import test from 'node:test'
import assert from 'node:assert/strict'
import { MachineSessions } from '../../computer-host/sessions.js'

test('TURN credentials rotate only for an approved session and survive a transient issuer failure', async (t) => {
  const first = {
    host: [{ urls: 'turn:a', credential: 'h1' }],
    viewer: [{ urls: 'turn:a', credential: 'v1' }],
    expiresAt: 4000,
  }
  const second = {
    host: [{ urls: 'turn:a', credential: 'h2' }],
    viewer: [{ urls: 'turn:a', credential: 'v2' }],
    expiresAt: 7000,
  }
  let now = 1000,
    attempts = 0
  const host = new MachineSessions({
    desktop: { probe: async () => ({ available: true }) },
    name: 'host',
    grants: () => [],
    audit() {},
    iceNow: () => now,
    issueIce: async () => [first, { host: [], viewer: [], retry: true }, second][attempts++],
  })
  t.after(() => host.stop())
  const peer = { deviceId: 'peer', tunnelId: 'tunnel', signal: new AbortController().signal }
  const pending = await host.call('session.open', { mode: 'desktop', requestId: 'a' }, peer)
  assert.equal(attempts, 0)
  await host.decide(pending.sessionId, true)
  const renew = () => host.call('session.renew', { sessionId: pending.sessionId }, peer)
  assert.equal((await renew()).iceServers[0].credential, 'v1')
  now = 3000
  const concurrent = await Promise.all([renew(), renew()])
  assert.equal(attempts, 2)
  assert.ok(concurrent.every((value) => value.iceServers[0].credential === 'v1' && value.iceGeneration === 0))
  now = 3999
  await renew()
  assert.equal(attempts, 2)
  now = 4000
  const rotated = await renew()
  assert.equal(rotated.iceGeneration, 1)
  assert.equal(rotated.iceServers[0].credential, 'v2')
  await host.call('session.close', { sessionId: pending.sessionId }, peer)
  const closed = await renew()
  assert.equal(closed.iceServers, undefined)
  assert.equal(attempts, 3)
})
