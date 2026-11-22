// Exercise a standalone installation against its own local relay. The first pass
// saves only a disposable controller identity; --resume tests a host reboot.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    identity: { type: 'string' },
    resume: { type: 'boolean' },
    headless: { type: 'boolean' },
  },
})
if (!values.home || !values.identity) throw Error('Specify --home and --identity for a disposable installation')
const installed = join(homedir(), '.local/share/godbot-computer/current')
const { localRequest } = await import(pathToFileURL(join(installed, 'computer-host/local.js')))
const {
  generateKeyPair,
  deviceIdFor,
  randomToken,
  parseMachinePairingUri,
  SecureTransport,
  RelayTransport,
  RpcClient,
} = await import(pathToFileURL(join(installed, 'src/host/team-runtime/mobile-link.js')))
const admin = (method, ...args) => localRequest(values.home, method, args)
let key, offer, pairingCode
if (values.resume) ({ key, offer } = JSON.parse(readFileSync(values.identity, 'utf8')))
else {
  const keys = generateKeyPair()
  key = { ...keys, deviceId: deviceIdFor(keys.publicKey), accessToken: randomToken() }
  const parsed = parseMachinePairingUri((await admin('pair')).uri)
  ;({ code: pairingCode, ...offer } = parsed)
}
const relay = new RelayTransport(offer.server, {
  deviceId: key.deviceId,
  identityKey: key.publicKey,
  accessToken: key.accessToken,
  targetDeviceId: offer.hostDeviceId,
})
const rpc = new RpcClient(
  new SecureTransport(
    relay,
    key,
    { deviceId: offer.hostDeviceId, identityKey: offer.hostKey },
    { hello: { name: 'Package E2E controller', ...(pairingCode && { pairingCode }) } },
  ),
  5000,
)
await rpc.connect()
try {
  const hello = await rpc.rpc('computer.hello', {})
  assert.equal(hello.kind, 'computer')
  assert.equal(hello.terminal, true)
  if (values.headless) assert.equal(hello.desktop, false)
  if (!values.resume) {
    assert.deepEqual((await admin('controllers')).find((c) => c.deviceId === key.deviceId).grants, [])
    await admin('grant', key.deviceId, 'terminal')
    writeFileSync(values.identity, JSON.stringify({ key, offer }), { flag: 'wx', mode: 0o600 })
  }
  const s = await rpc.rpc('session.open', { mode: 'terminal', requestId: randomToken(12) })
  assert.equal(s.state, 'approved')
  const p = { sessionId: s.sessionId }
  await rpc.rpc('terminal.open', { ...p, cols: 80, rows: 24 })
  await rpc.rpc('terminal.resize', { ...p, cols: 119, rows: 38 })
  const seq = {
    ...p,
    seq: 1,
    data: Buffer.from('printf \'shell-%s\\n\' "$(id -un)"; stty size\n').toString('base64'),
  }
  await rpc.rpc('terminal.write', seq)
  await rpc.rpc('terminal.write', seq)
  let cursor = 0,
    text = ''
  const until = Date.now() + 5000
  while (Date.now() < until && !(text.includes('shell-' + hello.account) && text.includes('38 119'))) {
    await rpc.rpc('session.renew', p)
    const out = await rpc.rpc('terminal.read', { ...p, cursor, waitMs: 400 })
    cursor = out.cursor
    text += Buffer.from(out.data, 'base64').toString()
  }
  assert.ok(text.includes('shell-' + hello.account) && text.includes('38 119'))
  await rpc.rpc('session.close', p)
  if (values.resume) await admin('revoke', key.deviceId)
  console.log(
    JSON.stringify({
      host: hello.os,
      account: hello.account,
      desktop: hello.desktop,
      nativePty: true,
      sameIdentityAfterReboot: Boolean(values.resume),
      winsize: '119x38',
      duplicateInputAck: true,
    }),
  )
} finally {
  await rpc.close()
}
