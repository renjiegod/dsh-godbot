// PHONE: a phone pairs with Godbot through a godbot-server relay, calls the team endpoints over the
// end-to-end encrypted link, hands over its push key, and gets an encrypted push through (fake) FCM
// for a Bot reply while it is offline. Removing the phone on the computer locks it out.
import assert from 'node:assert/strict'
import { saveEvidence } from '../artifacts.mjs'
import { until } from '../host.mjs'
import { startRelay } from '../phone-relay.mjs'
import {
  PUSH_KEY_METHOD, RelayTransport, RpcClient, SecureTransport,
  decryptPush, deviceIdFor, generateKeyPair, generatePushKey, parsePairingUri, randomToken,
} from '../../../src/host/team-runtime/mobile-link.js'

const FCM_TOKEN = 'e2e-fcm-registration-token'

async function channel(host, endpoint, payload = null) {
  const res = await host.page.context().request.post(host.url + '/api/godbot/team', {
    data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15_000,
  })
  assert.ok(res.ok(), 'team channel ' + endpoint + ' returned HTTP ' + res.status())
  const result = await res.json()
  if (!result.ok) throw Object.assign(new Error(endpoint + ': ' + result.error?.message), { code: result.error?.code })
  return result.value
}

function phoneIdentity() {
  const keys = generateKeyPair()
  return { deviceId: deviceIdFor(keys.publicKey), ...keys, accessToken: randomToken() }
}

async function openLink(offer, phone, pairingCode) {
  const relay = new RelayTransport(offer.server, {
    deviceId: phone.deviceId, identityKey: phone.publicKey, accessToken: phone.accessToken,
    targetDeviceId: offer.hostDeviceId, push: true,
  })
  const secure = new SecureTransport(relay, phone, { deviceId: offer.hostDeviceId, identityKey: offer.hostKey }, {
    hello: { name: 'E2E Pixel', ...(pairingCode === undefined ? {} : { pairingCode }) },
  })
  const client = new RpcClient(secure)
  await client.connect()
  const bot = async (endpoint, payload = {}) => {
    const result = await client.rpc('bot', { endpoint, payload })
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  return { relay, client, bot, close: () => client.close() }
}

export default async function check({ makeHost, candidate, reportDir, scratch, note }) {
  const relay = await startRelay(scratch, note)
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()

    // The computer connects out to the relay and takes the push extension.
    await channel(host, 'phone-set', { server: relay.url, on: true })
    const online = await until(async () => {
      const view = await channel(host, 'phone-set', {})
      if (view.status === 'online' && view.pushAvailable) return view
    }, 'Godbot online at the relay with push', 30_000)
    assert.equal(online.pushEnabled, true)
    note('host-online', { status: online.status, pushAvailable: online.pushAvailable })

    // Pairing: the QR code names the relay and this computer's key; the code rides the handshake.
    const pairing = (await channel(host, 'phone-pair')).pairing
    assert.ok(pairing.uri.startsWith('godbot://pair?'), pairing.uri)
    const offer = parsePairingUri(pairing.uri)
    assert.equal(offer.server, relay.url)
    const phone = phoneIdentity()
    const first = await openLink(offer, phone, offer.code)
    const hello = await first.bot('hello', { api: [1] })
    assert.equal(hello.api, 1)
    assert.equal(hello.plugin.name, 'dsh-godbot')
    await first.close()
    const paired = await until(async () => (await channel(host, 'phone-set', {})).phones.find(row => row.id === phone.deviceId), 'the paired phone on the computer')
    assert.equal(paired.name, 'E2E Pixel')
    note('paired', { phone: phone.deviceId })

    // Later connections need no code. Calls reach the same team endpoints as the window.
    const link = await openLink(offer, phone)
    const state = await link.bot('state', {})
    const lead = state.bots.find(bot => bot.id === state.mainBotId)
    assert.ok(lead, 'the team has a Main Bot')
    const big = await link.client.rpc('bot', { endpoint: 'hello', payload: { api: [1], pad: 'x'.repeat(300_000) } })
    assert.equal(big.ok, true, 'a 300 KB call crosses the relay in fragments')

    // Push: the key goes to the computer inside the link; the token goes to the relay.
    assert.equal(link.relay.pushAvailable, true)
    const pushKey = generatePushKey()
    assert.deepEqual(await link.client.rpc(PUSH_KEY_METHOD, { key: pushKey }), { ok: true })
    assert.deepEqual(await link.relay.registerPush(FCM_TOKEN, [offer.hostDeviceId]), { ok: true })
    const withKey = (await channel(host, 'phone-set', {})).phones.find(row => row.id === phone.deviceId)
    assert.equal(withKey.push, true)
    assert.equal(withKey.connected, true)

    // While the phone is connected, news arrives as feed events over the link, not as a push.
    const events = []
    link.client.onEvent(event => events.push(event))
    const liveMarker = 'PHONE-live-' + Date.now()
    host.model.reply = () => 'Reply for ' + liveMarker
    const pushesBefore = relay.google.messages.length
    await host.bot('send', { sessionId: lead.sessionId ?? lead.id, text: 'ping ' + liveMarker })
    const live = await until(() => events.find(event => event.event === 'notice' && event.data?.kind === 'message' && String(event.data?.text).includes(liveMarker)),
      'the Bot reply as a notice event on the open link', 40_000)
    assert.equal(live.data.botId, lead.id)
    assert.equal(relay.google.messages.length, pushesBefore, 'no push goes to a connected phone')
    note('live-event', { kinds: [...new Set(events.map(event => event.event))] })

    // The Bot asks with a question card; the phone answers it, and the Bot goes on with the choice.
    const askMarker = 'PHONE-ask-' + Date.now()
    let asked = false
    host.model.reply = ({ messages }) => {
      const text = JSON.stringify(messages ?? [])
      if (text.includes('dev') && asked && !text.includes('Chose dev for ' + askMarker)) return 'Chose dev for ' + askMarker
      if (text.includes(askMarker) && !asked) {
        asked = true
        return [{ type: 'tool_use', name: 'ask_user', input: { question: 'Which branch? ' + askMarker, options: [{ label: 'main' }, { label: 'dev' }] } }]
      }
      return 'Fixture acknowledged'
    }
    await host.bot('send', { sessionId: lead.sessionId ?? lead.id, text: 'ask me ' + askMarker })
    await until(() => events.find(event => event.event === 'notice' && event.data?.kind === 'question' && String(event.data?.text).includes(askMarker)),
      'the question card as a notice on the phone', 40_000)
    const card = await until(async () => {
      const current = await link.bot('state', {})
      for (const [sessionId, question] of Object.entries(current.questions ?? {})) {
        if (String(question?.question).includes(askMarker)) return { sessionId, question }
      }
    }, 'the question in the team state the phone reads')
    await link.bot('answer-question', { sessionId: card.sessionId, questionId: card.question.id, answer: { selected: ['dev'], custom: '' } })
    await until(async () => !Object.values((await host.bot('state')).questions ?? {}).some(question => String(question?.question).includes(askMarker)),
      'the answered card gone on the computer', 20_000)
    await until(() => events.find(event => event.event === 'notice' && event.data?.kind === 'message' && String(event.data?.text).includes('Chose dev for ' + askMarker)),
      'the Bot going on with the answer from the phone', 40_000)
    note('answered-from-phone', { question: card.question.id })
    await link.close()
    await until(async () => !(await channel(host, 'phone-set', {})).phones.find(row => row.id === phone.deviceId)?.connected, 'the phone offline on the computer')

    // A Bot reply while the phone is away comes through FCM, sealed for this phone only.
    const marker = 'PHONE-push-' + Date.now()
    host.model.reply = () => 'Reply for ' + marker
    await host.bot('send', { sessionId: lead.sessionId ?? lead.id, text: 'ping ' + marker })
    const sent = await until(() => relay.google.messages.find(entry => {
      const data = entry.body?.message?.data
      if (data?.h !== offer.hostDeviceId) return false
      try { return decryptPush(pushKey, data.h, data.c).body.includes(marker) } catch { return false }
    }), 'an encrypted push for the Bot reply', 40_000)
    const message = sent.body.message
    assert.equal(message.token, FCM_TOKEN)
    assert.equal(message.android.priority, 'HIGH')
    assert.equal(sent.authorization, 'Bearer fake-access-token')
    assert.ok(!JSON.stringify(message).includes(marker), 'FCM never sees the text')
    const opened = decryptPush(pushKey, message.data.h, message.data.c)
    assert.equal(opened.kind, 'message')
    assert.equal(opened.botId, lead.id)
    assert.equal(opened.title, lead.name)
    const status = (await channel(host, 'phone-set', {})).phones.find(row => row.id === phone.deviceId)
    assert.equal(status.lastPush?.ok, true)
    note('pushed', { kind: opened.kind, fcmMessages: relay.google.messages.length })

    // The relay restarts on the same port with the same database: the computer reconnects by
    // itself, the phone comes back without a code, and its push token survived.
    await relay.restart()
    await until(async () => {
      const view = await channel(host, 'phone-set', {})
      return view.status === 'online' && view.pushAvailable
    }, 'Godbot back online after the relay restart', 90_000)
    const again = await openLink(offer, phone)
    assert.equal((await again.bot('hello', { api: [1] })).api, 1)
    await again.close()
    await until(async () => !(await channel(host, 'phone-set', {})).phones.find(row => row.id === phone.deviceId)?.connected, 'the phone offline again')
    const afterRestart = 'PHONE-restart-' + Date.now()
    host.model.reply = () => 'Reply for ' + afterRestart
    await host.bot('send', { sessionId: lead.sessionId ?? lead.id, text: 'ping ' + afterRestart })
    await until(() => relay.google.messages.find(entry => {
      const data = entry.body?.message?.data
      try { return data?.h === offer.hostDeviceId && decryptPush(pushKey, data.h, data.c).body.includes(afterRestart) } catch { return false }
    }), 'a push after the restart, with the stored token', 60_000)
    note('restart-recovered', { fcmMessages: relay.google.messages.length })

    // Removing the phone on the computer locks it out and forgets its push key.
    await channel(host, 'phone-remove', { id: phone.deviceId })
    await assert.rejects(openLink(offer, phone), error => error.code === 'NOT_PAIRED' || /not paired/i.test(error.message))
    note('revoked', { phone: phone.deviceId })
    await saveEvidence(reportDir, 'phone.json', { relay: relay.url, pairingScheme: 'godbot', pushes: relay.google.messages.length })
  } finally {
    await relay.close()
  }
}
