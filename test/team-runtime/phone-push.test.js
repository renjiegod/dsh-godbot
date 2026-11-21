import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../../src/host/team-runtime/core/phone.js'
import { decryptPush, deviceIdFor, generateKeyPair, generatePushKey, randomToken } from '../../src/host/team-runtime/mobile-link.js'

class FakeLink {
  constructor(options) {
    this.options = options
    this.pushAvailable = true
    this.connected = []
    this.sent = []
    this.status = 'online'
    this.stopped = false
  }

  start() {}
  async stop() { this.stopped = true }
  connectedDevices() { return this.connected }
  disconnect() {}
  emit() {}
  sendPush(targetDeviceId, ciphertext, options) {
    this.sent.push({ targetDeviceId, ciphertext, options })
    return Promise.resolve(this.answer ?? { ok: true })
  }
}

const host = generateKeyPair()
const hostId = deviceIdFor(host.publicKey)
const phone = generateKeyPair()
const phoneId = deviceIdFor(phone.publicKey)
const signal = new AbortController().signal

async function setup(t, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'godbot-phone-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, 'phone.json'), JSON.stringify({
    version: 2,
    on: true,
    server: 'ws://127.0.0.1:9/v1/link',
    identity: { deviceId: hostId, ...host },
    accessToken: randomToken(),
    devices: [{ deviceId: phoneId, identityKey: phone.publicKey, name: 'Pixel', pairedAt: 1 }],
    ...extra,
  }))
  const links = []
  const rt = {
    home,
    config: {},
    state: { revision: 1 },
    readOnly: () => undefined,
    feedTap: () => () => {},
    load: async () => {},
    ctx: { effect: run => { run() } },
    createPhoneLink: options => {
      const link = new FakeLink(options)
      links.push(link)
      return link
    },
  }
  install(rt)
  rt.phoneServe(async () => ({ ok: true, value: null }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(links.length, 1, 'the link starts once the channel is served')
  const saved = async () => JSON.parse(await readFile(join(home, 'phone.json'), 'utf8'))
  return { rt, links, link: links[0], saved }
}

test('the link offers push unless it was turned off', async t => {
  const { link } = await setup(t)
  assert.equal(link.options.push, true)
  const off = await setup(t, { push: false })
  assert.equal(off.link.options.push, false)
})

test('a paired phone hands over its push key through the link', async t => {
  const { link, saved } = await setup(t)
  const key = generatePushKey()
  assert.deepEqual(await link.options.handle('push.key', { key }, { deviceId: phoneId, signal }), { ok: true })
  assert.equal((await saved()).pushKeys[phoneId].key, key)
  await assert.rejects(link.options.handle('push.key', { key: 'nope' }, { deviceId: phoneId, signal }), { code: 'INVALID_PARAMS' })
  await assert.rejects(link.options.handle('push.key', { key }, { deviceId: 'd-AAAAAAAAAAAAAAAAAAAAAA', signal }), { code: 'NOT_PAIRED' })
  await assert.rejects(link.options.handle('other', {}, { deviceId: phoneId, signal }), { code: 'METHOD_NOT_FOUND' })
})

test('a notice reaches an offline phone sealed with its key', async t => {
  const { rt, link } = await setup(t)
  const key = generatePushKey()
  await link.options.handle('push.key', { key }, { deviceId: phoneId, signal })
  rt.phonePush({ seq: 3, time: 5, kind: 'approval', botId: 'b1', name: 'Coder', sessionId: 's1', roomId: 'r1', title: 'Release', text: 'bash' })
  assert.equal(link.sent.length, 1)
  const [sent] = link.sent
  assert.equal(sent.targetDeviceId, phoneId)
  assert.deepEqual(sent.options, { collapseKey: 'approval:s1', ttlSeconds: 21600 })
  assert.deepEqual(decryptPush(key, hostId, sent.ciphertext), {
    v: 1, kind: 'approval', title: 'Coder · Release', body: 'bash', time: 5, seq: 3, botId: 'b1', sessionId: 's1', roomId: 'r1',
  })
  await new Promise(resolve => setImmediate(resolve))
  const view = rt.phoneView()
  assert.equal(view.pushEnabled, true)
  assert.equal(view.pushAvailable, true)
  assert.equal(view.phones[0].push, true)
  assert.equal(view.phones[0].lastPush.ok, true)
})

test('nothing is pushed to a connected phone, for chatter, without a key or without Server support', async t => {
  const { rt, link } = await setup(t)
  const notice = { seq: 1, time: 1, kind: 'message', botId: 'b1', name: 'Coder', sessionId: 's1', text: 'done' }
  rt.phonePush(notice)
  assert.equal(link.sent.length, 0, 'no key yet')
  await link.options.handle('push.key', { key: generatePushKey() }, { deviceId: phoneId, signal })
  rt.phonePush({ ...notice, kind: 'group' })
  assert.equal(link.sent.length, 0, 'group lines are not pushed')
  link.connected = [phoneId]
  rt.phonePush(notice)
  assert.equal(link.sent.length, 0, 'a connected phone hears it over the link')
  link.connected = []
  link.pushAvailable = false
  rt.phonePush(notice)
  assert.equal(link.sent.length, 0, 'the Server did not take push')
  link.pushAvailable = true
  rt.phonePush(notice)
  assert.equal(link.sent.length, 1)
})

test('a failed push shows on the phone row', async t => {
  const { rt, link } = await setup(t)
  await link.options.handle('push.key', { key: generatePushKey() }, { deviceId: phoneId, signal })
  link.answer = { ok: false, code: 'PUSH_TOKEN_UNKNOWN' }
  rt.phonePush({ seq: 1, time: 1, kind: 'question', botId: 'b1', name: 'Coder', sessionId: 's1', text: 'Which branch?' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual({ ...rt.phoneView().phones[0].lastPush, at: 0 }, { at: 0, ok: false, code: 'PUSH_TOKEN_UNKNOWN' })
})

test('removing a phone forgets its push key', async t => {
  const { rt, link, saved } = await setup(t)
  await link.options.handle('push.key', { key: generatePushKey() }, { deviceId: phoneId, signal })
  const view = await rt.phoneEndpoint('phone-remove', { id: phoneId })
  assert.deepEqual(view.phones, [])
  assert.equal((await saved()).pushKeys[phoneId], undefined)
})

test('turning push off reconnects without the offer', async t => {
  const { rt, links, saved } = await setup(t)
  const view = await rt.phoneEndpoint('phone-set', { push: false })
  assert.equal(links[0].stopped, true)
  assert.equal(links.length, 2)
  assert.equal(links[1].options.push, false)
  assert.equal(view.pushEnabled, false)
  assert.equal((await saved()).push, false)
})
