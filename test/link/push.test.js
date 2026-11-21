import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_PUSH_CIPHERTEXT, decryptPush, deviceIdFor, encryptPush, generateKeyPair, generatePushKey, isPushKey, pairingUri, parsePairingUri } from '../../src/link/index.ts'

const host = generateKeyPair()
const hostId = deviceIdFor(host.publicKey)
const note = { v: 1, kind: 'approval', title: 'Coder', body: 'Wants to run: npm test', botId: 'b1', sessionId: 's1', seq: 7, time: 1_732_170_000_000 }

test('a push key is 32 random bytes in unpadded base64url', () => {
  const key = generatePushKey()
  assert.ok(isPushKey(key))
  assert.notEqual(key, generatePushKey())
  assert.equal(isPushKey('short'), false)
  assert.equal(isPushKey(`${key}=`), false)
})

test('a notification opens with its key for the same computer', () => {
  const key = generatePushKey()
  const sealed = encryptPush(key, hostId, note)
  assert.match(sealed, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(decryptPush(key, hostId, sealed), note)
  // A fresh nonce each time.
  assert.notEqual(encryptPush(key, hostId, note), sealed)
})

test('a notification does not open with another key or for another computer', () => {
  const key = generatePushKey()
  const sealed = encryptPush(key, hostId, note)
  assert.throws(() => decryptPush(generatePushKey(), hostId, sealed))
  assert.throws(() => decryptPush(key, deviceIdFor(generateKeyPair().publicKey), sealed))
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BA' : 'AA')
  assert.throws(() => decryptPush(key, hostId, tampered))
})

test('a long body is cut so the notification fits FCM', () => {
  const key = generatePushKey()
  const sealed = encryptPush(key, hostId, { ...note, body: 'x'.repeat(5000) })
  assert.ok(sealed.length <= MAX_PUSH_CIPHERTEXT)
  const opened = decryptPush(key, hostId, sealed)
  assert.equal(opened.body.length, 1000)
  assert.ok(opened.body.endsWith('…'))
})

test('pairing codes use godbot:// and both schemes parse', () => {
  const offer = { server: 'wss://relay.example/v1/link', hostDeviceId: hostId, hostKey: host.publicKey, code: 'c0de', name: 'My Mac' }
  const uri = pairingUri(offer)
  assert.ok(uri.startsWith('godbot://pair?'))
  assert.deepEqual(parsePairingUri(uri), offer)
  assert.deepEqual(parsePairingUri(uri.replace(/^godbot:/, 'dsbot:')), offer)
  assert.throws(() => parsePairingUri(uri.replace(/^godbot:/, 'https:')), /Invalid phone pairing code/)
})
