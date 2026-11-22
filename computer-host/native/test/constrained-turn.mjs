// Real desktop through the project's Noise broker and TURN on the isolated
// booted GTK validation target. The fixture proxy paces the media TCP stream.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { RemoteComputers } from '../../../src/host/remote-computers.js'

const validation = process.env.GODBOT_MACHINE_VALIDATION_DIR
if (!validation) throw Error('Set GODBOT_MACHINE_VALIDATION_DIR to the local validation directory')
const stage = 'godbot-remote-x11-turn'
const docker = (args) => execFileSync('docker', ['exec', stage, ...args], { encoding: 'utf8' }).trim()
const manage = (...args) => JSON.parse(docker(['/native/node', '/src/computer-host/cli.mjs', ...args]))
const meter = () => JSON.parse(docker(['cat', '/home/godbotqa/desktop/turn-meter.json']))
const profile = await mkdtemp(join(tmpdir(), 'godbot-low-controller-'))
const broker = new RemoteComputers(profile)
const controller = new AbortController()
const peer = { id: 'native-validation-' + randomUUID(), signal: controller.signal }
const viewId = randomUUID()
const call = (request) => broker.handle({ ...request, viewId }, peer)
let id, session, timer, renewError, web, viewerId
const evidence = { started: new Date().toISOString(), profiles: [] }
function rpc(method, params = {}) {
  return call({ action: 'rpc', id, method, params: { sessionId: session?.sessionId, ...params } })
}
async function wait(fn, deadline = 20000) {
  const until = Date.now() + deadline
  for (;;) {
    const value = await fn()
    if (value) return value
    if (renewError) throw renewError
    if (Date.now() > until) throw Error('Validation timed out')
    await sleep(100)
  }
}
try {
  const offerPath = execFileSync(join(validation, 'x11-turn', 'issue-offer'), [], { encoding: 'utf8' }).trim()
  let pair
  try {
    pair = await call({ action: 'pair', offer: (await readFile(offerPath, 'utf8')).trim() })
  } finally {
    await unlink(offerPath)
  }
  id = pair.machine.id
  viewerId = broker.data.identity.deviceId
  await call({ action: 'connect', id })
  session = await rpc('session.open', { mode: 'desktop', requestId: randomUUID() })
  if (session.state === 'pending') manage('approve', session.sessionId)
  session = await rpc('session.status')
  assert.equal(session.state, 'approved')
  assert.ok(
    session.iceServers.some((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((url) => url.startsWith('turn:')),
    ),
  )
  timer = setInterval(
    () =>
      rpc('session.renew').catch((e) => {
        renewError = e
      }),
    1000,
  )
  const display = (await rpc('desktop.displays')).displays[0]
  web = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await web.newPage()
  await page.goto('about:blank')
  await page.evaluate(() => {
    window.screenVideo = document.createElement('video')
    screenVideo.muted = true
    screenVideo.autoplay = true
    document.body.appendChild(screenVideo)
  })
  let generation = 0
  for (const quality of ['balanced', 'low']) {
    generation++
    const offer = await page.evaluate(async (servers) => {
      window.pc?.close()
      const pc = (window.pc = new RTCPeerConnection({ iceTransportPolicy: 'relay', iceServers: servers }))
      window.inputs = pc.createDataChannel('godbot-input-v1')
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.ontrack = (e) => {
        screenVideo.srcObject = new MediaStream([e.track])
        screenVideo.play().catch(() => {})
      }
      const complete = new Promise((resolve) =>
        pc.addEventListener('icecandidate', (e) => {
          if (!e.candidate) resolve()
        }),
      )
      await pc.setLocalDescription(await pc.createOffer())
      await complete
      return pc.localDescription.toJSON()
    }, session.iceServers)
    await rpc('desktop.signal', { generation, quality, displayId: display.id, signal: offer })
    let cursor = 0,
      answered = false
    const candidates = []
    await wait(async () => {
      const res = await rpc('desktop.poll', { generation, cursor, waitMs: 100 })
      cursor = res.cursor
      for (const signal of res.signals) {
        if (signal.type === 'answer' && !answered) {
          await page.evaluate((s) => pc.setRemoteDescription(s), signal)
          answered = true
        }
        if (signal.type === 'candidate') candidates.push(signal.candidate)
      }
      if (answered)
        while (candidates.length) await page.evaluate((c) => pc.addIceCandidate(c), candidates.shift())
      return answered && page.evaluate(() => inputs.readyState === 'open' && screenVideo.readyState >= 2)
    }, 30000)
    const stats = () =>
      page.evaluate(async () => {
        const all = [...(await pc.getStats()).values()]
        const stream = all.find((s) => s.type === 'inbound-rtp' && s.kind === 'video')
        const transport = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId)
        const pair = all.find((s) => s.id === transport.selectedCandidatePairId)
        return {
          time: stream.timestamp,
          bytes: stream.bytesReceived,
          decoded: stream.framesDecoded,
          drops: stream.framesDropped,
          width: stream.frameWidth,
          height: stream.frameHeight,
          local: all.find((s) => s.id === pair.localCandidateId).candidateType,
          remote: all.find((s) => s.id === pair.remoteCandidateId).candidateType,
          rttMs: Math.round((pair.currentRoundTripTime ?? 0) * 1000),
        }
      })
    await sleep(1800)
    const before = await stats(),
      startMeter = meter()
    assert.equal(before.local, 'relay')
    assert.equal(before.remote, 'relay')
    if (quality === 'low') {
      assert.equal(before.width, 960)
      assert.equal(before.height, 540)
    } else {
      assert.equal(before.width, 1280)
      assert.equal(before.height, 720)
    }
    const state = await rpc('desktop.requestControl')
    if (state.controlPending && state.controlPrompt !== 'system') manage('approve', session.sessionId)
    await wait(async () => (await rpc('session.status')).control)
    const marker = 'Quality' + quality + randomUUID().slice(0, 6)
    const point = docker(['cat', '/home/godbotqa/desktop/point']).split(' ').map(Number)
    await page.evaluate(
      ({ display, point, marker }) => {
        const x = point[0] / display.width,
          y = point[1] / display.height
        const send = (e) =>
          inputs.send(JSON.stringify({ ...e, displayId: display.id, revision: display.revision }))
        send({ type: 'button', x, y, button: 0, down: true })
        send({ type: 'button', x, y, button: 0, down: false })
        send({ type: 'key', code: 'ControlLeft', down: true })
        send({ type: 'key', code: 'KeyA', down: true })
        send({ type: 'key', code: 'KeyA', down: false })
        send({ type: 'key', code: 'ControlLeft', down: false })
        send({ type: 'text', text: marker })
      },
      { display, point, marker },
    )
    await wait(() => docker(['sh', '-c', 'cat "$HOME/desktop/receipt" 2>/dev/null || true']) === marker)
    await sleep(12000)
    const after = await stats(),
      endMeter = meter()
    const duration = (after.time - before.time) / 1000
    const observed = {
      quality,
      width: after.width,
      height: after.height,
      seconds: +duration.toFixed(2),
      decodedFPS: +((after.decoded - before.decoded) / duration).toFixed(1),
      videoBitsPerSecond: Math.round(((after.bytes - before.bytes) * 8) / duration),
      frameDrops: after.drops - before.drops,
      pacedTurnUploadBitsPerSecond: Math.round(
        ((endMeter.uploadBytes - startMeter.uploadBytes) * 8) /
          (endMeter.elapsedSeconds - startMeter.elapsedSeconds),
      ),
      configuredCapBitsPerSecond: endMeter.limitBitsPerSecond,
      simultaneousTcpConnections: endMeter.openTurnConnections,
      localCandidate: after.local,
      remoteCandidate: after.remote,
      rttMs: after.rttMs,
      gtkReceipt: true,
    }
    assert.ok(after.decoded > before.decoded)
    assert.ok(observed.pacedTurnUploadBitsPerSecond <= endMeter.limitBitsPerSecond * 1.05)
    evidence.profiles.push(observed)
    console.log(observed)
    await rpc('desktop.releaseControl')
  }
  evidence.ok = true
} finally {
  clearInterval(timer)
  if (session) await rpc('session.close').catch(() => {})
  await web?.close()
  controller.abort()
  await broker.close()
  if (viewerId) manage('revoke', viewerId)
  await rm(profile, { recursive: true, force: true })
  evidence.finished = new Date().toISOString()
  await writeFile(join(validation, 'constrained-turn.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  })
}
