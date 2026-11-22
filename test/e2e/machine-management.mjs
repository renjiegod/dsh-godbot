import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagementWindow } from '../../computer-host/manage.js'
import { startComputerHost } from '../../computer-host/runtime.js'
import { localRequest } from '../../computer-host/local.js'
import {
  generateKeyPair,
  deviceIdFor,
  randomToken,
  parseMachinePairingUri,
  RelayTransport,
  RpcClient,
  SecureTransport,
} from '../../src/host/team-runtime/mobile-link.js'
import { startRelay } from './phone-relay.mjs'
import { openBrowser, until } from './host.mjs'

const root = await mkdtemp(join(tmpdir(), 'godbot-native-settings-'))
const relay = await startRelay(root, () => {})
let host, manager, otherManager, browser, client
try {
  host = await startComputerHost({
    home: join(root, 'host'),
    name: 'Settings validation',
    relay: relay.url,
    headless: true,
    noPrompts: true,
  })
  await until(() => host.link.status === 'online', 'target online')
  manager = await createManagementWindow(host.directory)
  const origin = new URL(manager.url).origin
  const denied = await fetch(origin + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://external.invalid' },
    body: JSON.stringify({ action: 'enter', key: new URL(manager.url).hash.slice(1) }),
  })
  assert.equal(denied.status, 403)
  otherManager = await createManagementWindow(host.directory)
  const otherURL = new URL(otherManager.url)
  async function action(origin, body, windowKey) {
    return fetch(origin + '/action', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(windowKey && { 'x-godbot-window': windowKey }),
      },
      body: JSON.stringify(body),
    })
  }
  const entered = await action(otherURL.origin, { action: 'enter', key: otherURL.hash.slice(1) })
  assert.equal(entered.status, 200)
  assert.equal(entered.headers.get('set-cookie'), null)
  const { windowKey } = await entered.json()
  assert.ok(windowKey)
  assert.equal((await action(otherURL.origin, { action: 'enter', key: otherURL.hash.slice(1) })).status, 403)
  ;({ browser } = await openBrowser())
  const page = await browser.newPage()
  await page.goto(manager.url)
  await page.getByRole('heading', { name: 'Settings validation' }).waitFor()
  assert.equal((await action(origin, { action: 'status' }, windowKey)).status, 403)
  assert.equal((await action(otherURL.origin, { action: 'status' }, windowKey)).status, 200)
  assert.equal((await action(otherURL.origin, { action: 'status' })).status, 403)
  assert.deepEqual(await page.context().cookies(), [])
  await otherManager.close()
  await page.getByRole('button', { name: 'Pair controller' }).click()
  const offer = parseMachinePairingUri(await page.locator('dialog code').textContent())
  const keys = generateKeyPair(),
    identity = { ...keys, deviceId: deviceIdFor(keys.publicKey) }
  const transport = new RelayTransport(offer.server, {
    deviceId: identity.deviceId,
    identityKey: keys.publicKey,
    accessToken: randomToken(),
    targetDeviceId: offer.hostDeviceId,
  })
  client = new RpcClient(
    new SecureTransport(
      transport,
      identity,
      { deviceId: offer.hostDeviceId, identityKey: offer.hostKey },
      { hello: { name: 'QA controller', pairingCode: offer.code } },
    ),
  )
  await client.connect()
  assert.equal((await client.rpc('computer.hello', {})).kind, 'computer')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('heading', { name: 'QA controller' }).waitFor()
  await page.getByRole('checkbox', { name: 'Terminal', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await until(
    async () => (await localRequest(host.directory, 'controllers'))[0]?.grants.includes('terminal'),
    'remembered grant on the target',
  )
  const session = await client.rpc('session.open', { mode: 'terminal', requestId: 'host-window-test' })
  assert.equal(session.state, 'approved')
  await page.getByRole('button', { name: 'Stop session' }).click()
  await until(async () => (await localRequest(host.directory, 'sessions')).length === 0, 'target stop')
  await page.getByRole('button', { name: 'Revoke', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await until(async () => (await localRequest(host.directory, 'controllers')).length === 0, 'revocation')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByText('Settings closed.', { exact: true }).waitFor()
  console.log('Passed trusted host UI enrollment, scope change, stop, revoke and origin rejection.')
} finally {
  await client?.close().catch(() => {})
  await otherManager?.close()
  await manager?.close()
  await browser?.close()
  await host?.close()
  await relay.close()
  await rm(root, { recursive: true, force: true })
}
