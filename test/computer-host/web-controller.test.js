import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { RemoteComputers } from '../../src/host/remote-computers.js'
import { deviceIdFor, generateKeyPair, machinePairingUri } from '../../src/host/team-runtime/mobile-link.js'

function offer(name) {
  const keys = generateKeyPair()
  const record = {
    name,
    server: 'ws://127.0.0.1:9999/v1/link',
    hostDeviceId: deviceIdFor(keys.publicKey),
    hostKey: keys.publicKey,
    code: randomUUID(),
  }
  return { record, uri: machinePairingUri(record) }
}

test('tabs share one machine connection and isolate ownership across reuse, target switches and owner disconnects', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'godbot-controller-test-'))
  const calls = []
  let hasDesktop = false
  let rejectSession = false
  const manager = new RemoteComputers(path, (_identity, target) => {
    let close
    return {
      onClose(cb) {
        close = cb
      },
      async connect() {},
      async close() {
        close?.()
      },
      async rpc(method, p) {
        calls.push([target.name, method, p])
        if (method === 'computer.hello')
          return { kind: 'computer', version: 1, name: target.name, os: 'Linux', account: 'owner', desktop: hasDesktop, terminal: true }
        if (method === 'session.open') {
          if (rejectSession) throw new Error('Open this computer in the current tab first')
          return { sessionId: randomUUID(), mode: p.mode, state: 'approved', expiresAt: Date.now() + 5000 }
        }
        return { ok: true }
      },
    }
  })
  t.after(async () => {
    await manager.close()
    await rm(path, { recursive: true, force: true })
  })
  const first = offer('A'),
    second = offer('B')
  const owners = [new AbortController(), new AbortController()]
  const viewId = randomUUID()
  const call = (peer, action, extra = {}) =>
    manager.handle({ viewId, action, ...extra }, { id: 'peer-' + peer, signal: owners[peer].signal })
  await call(0, 'pair', { offer: first.uri })
  await call(0, 'pair', { offer: second.uri })
  const file = readFileSync(manager.file, 'utf8')
  assert.equal(statSync(manager.file).mode & 0o077, 0)
  assert.ok(!file.includes(first.record.code) && !file.includes(second.record.code))
  const paired = JSON.parse(file).machines.find((m) => m.hostDeviceId === first.record.hostDeviceId)
  assert.deepEqual([paired.desktop, paired.terminal], [false, true])
  const preview = await call(0, 'inspect', { offer: first.uri })
  assert.equal(preview.desktop, undefined)
  hasDesktop = true
  const id = first.record.hostDeviceId
  await call(0, 'connect', { id })
  await call(1, 'connect', { id })
  const open = { id, method: 'session.open', params: { mode: 'terminal', requestId: 'same' } }
  const connectionAware = { ...open, reportConnectionRequired: true }
  const s = await call(0, 'rpc', open)
  await assert.rejects(
    call(1, 'rpc', { id, method: 'terminal.read', params: { sessionId: s.sessionId } }),
    /does not own/,
  )
  await assert.rejects(call(1, 'connect', { id: second.record.hostDeviceId }), /Another tab/)
  await call(1, 'rpc', open)
  const keys = calls.filter((c) => c[1] === 'session.open').map((c) => c[2].requestId)
  assert.equal(keys.length, 2)
  assert.notEqual(keys[0], keys[1])
  owners[0].abort()
  await manager.queue
  assert.ok(calls.some((c) => c[1] === 'session.close' && c[2].sessionId === s.sessionId))
  await call(1, 'leave')
  await call(1, 'connect', { id: second.record.hostDeviceId })
  const beforeDisconnectedOpen = calls.length
  assert.deepEqual(await call(1, 'rpc', connectionAware), { connectionRequired: true })
  assert.equal(calls.length, beforeDisconnectedOpen)
  await call(1, 'connect', { id })
  rejectSession = true
  const beforeRemoteFailure = calls.length
  await assert.rejects(call(1, 'rpc', connectionAware), /Open this computer in the current tab first/)
  assert.deepEqual(calls.slice(beforeRemoteFailure).map(([, method]) => method), ['session.open'])
  rejectSession = false
  const result = await call(1, 'rpc', connectionAware)
  assert.equal(result.session.state, 'approved')
  assert.equal(result.connectionRequired, undefined)
  const publicRecords = await call(1, 'list')
  assert.equal(publicRecords.find((m) => m.id === id).desktop, true)
  assert.ok(publicRecords.every((r) => !r.code && !r.privateKey && !r.accessToken && !r.hostKey))
  const forgetting = call(1, 'forget', { id })
  const reconnect = call(1, 'connect', { id })
  await Promise.all([forgetting, assert.rejects(reconnect, /Unknown remote computer/)])
  await call(1, 'pair', { offer: first.uri })
  const replacing = call(1, 'pair', { offer: first.uri })
  await Promise.all([replacing, call(1, 'forget', { id })])
  assert.ok(!(await call(1, 'list')).some((record) => record.id === id))
})
