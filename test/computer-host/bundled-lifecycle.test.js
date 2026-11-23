import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { BundledComputerHost } from '../../src/host/bundled-computer-host.js'
import { HostInstallation, atomic, maybe } from '../../src/host/bundled-host-installation.js'
import { MachineSessions } from '../../computer-host/sessions.js'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const relayA = 'ws://127.0.0.1:3210/v1/link',
  relayB = 'ws://127.0.0.1:3245/v1/link'
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'bundled-host-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const hostHome = join(home, 'target'),
    management = join(home, '.local/share/godbot-bundled-computer')
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    key = join(home, 'pinned.pem')
  await writeFile(key, keys.publicKey.export({ type: 'spki', format: 'pem' }))
  const encoder = Buffer.from('test-encoder'),
    mutable = {
      sessions: [],
      loaded: false,
      online: null,
      starts: 0,
      stops: 0,
      installs: 0,
      pairs: 0,
      permissions: 0,
      fences: 0,
    }
  function release(version) {
    const metadata = {}
    for (const component of ['host', 'desktop']) {
      const name = component === 'host' ? 'bin/godbot-computer' : 'native/platform'
      const content = component === 'host' ? '#!/bin/sh\n# Godbot Computer Host launcher\n' : 'native fixture'
      const files = { [name]: sha(content) }
      const bytes = JSON.stringify({ platform: 'darwin', arch: 'arm64', component, version, files })
      metadata[component] = { name, content, bytes, version }
    }
    return {
      version,
      manifests: Object.fromEntries(Object.entries(metadata).map(([k, m]) => [k, sha(m.bytes)])),
      key,
      prepare: async () => ({ metadata }),
      encoder: () => ({ sha256: sha(encoder) }),
      copyEncoder: async (dest) => {
        await writeFile(dest, encoder, { mode: 0o700 })
      },
    }
  }
  let bundle = release('0.1.2')
  const sys = new HostInstallation({ home, hostHome, management, bundle })
  sys.loaded = async () => mutable.loaded
  sys.daemon = async () => mutable.online
  sys.start = async (dir) => {
    const content = await sys.plist(dir),
      relay = content.match(/<string>--relay<\/string>\s*<string>([^<]+)<\/string>/)[1]
    const file = join(dir, 'identity.json')
    const saved = JSON.parse(
      (await maybe(readFile(file, 'utf8'))) || '{"key":"stable-test-identity","grants":["terminal"]}',
    )
    await atomic(file, JSON.stringify({ ...saved, relay }))
    mutable.loaded = true
    mutable.starts++
    mutable.online = {
      relay,
      status: 'online',
      fingerprint: 'ABCD',
      desktop: true,
      terminal: true,
      control: true,
      maintenanceSupported: mutable.modern !== false,
    }
  }
  sys.stop = async () => {
    mutable.stops++
    mutable.loaded = false
    mutable.online = null
  }
  sys.ready = async () => {
    if (mutable.failReady) {
      mutable.failReady = false
      throw Error('Test start failure')
    }
    return mutable.online
  }
  sys.request = async (dir, operation) => {
    if (operation === 'sessions') return mutable.sessions
    if (operation === 'maintenance-begin') {
      mutable.fences++
      return { ok: !mutable.fenceBusy }
    }
    if (operation === 'maintenance-end') return { ok: true }
    if (operation === 'pair') {
      mutable.pairs++
      return { uri: 'godbot://computer-pair?fixture', expiresAt: Date.now() + 30000 }
    }
    throw Error('Unexpected call ' + operation)
  }
  sys.openPermissions = async () => {
    mutable.permissions++
  }
  sys.install = async ({ metadata }, component) => {
    mutable.installs++
    if (mutable.failComponent === component) throw Error('Test component failure')
    const { name, content, version, bytes } = metadata[component]
    const target = 'releases/' + component + '-' + version + '-darwin-arm64-' + sha(bytes).slice(0, 12)
    const loc = join(sys.store, target),
      file = join(loc, name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content, { mode: 0o700 })
    await writeFile(join(loc, 'manifest.json'), bytes)
    await writeFile(join(loc, 'manifest.sig'), sign('sha256', Buffer.from(bytes), keys.privateKey))
    await copyFile(key, join(sys.store, 'publisher.pem'))
    const active = join(sys.store, component === 'host' ? 'current' : 'desktop-current')
    const prior = await maybe(readlink(active))
    if (prior) {
      await maybe(unlink(active + '-previous'))
      await symlink(prior, active + '-previous')
      await unlink(active)
    }
    await symlink(target, active)
    if (component === 'host') {
      await mkdir(dirname(sys.launcher), { recursive: true })
      await copyFile(file, sys.launcher)
    }
  }
  const manager = () =>
    new BundledComputerHost({
      platform: 'darwin',
      arch: 'arm64',
      home,
      hostHome,
      bundle,
      system: sys,
      retryMs: 50,
    })
  function upgrade(version) {
    bundle = release(version)
    sys.bundle = bundle
    return manager()
  }
  async function standalone(version, dir = hostHome) {
    const old = release(version)
    for (const comp of ['host', 'desktop']) await sys.install(await old.prepare(), comp)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await atomic(sys.definition(dir).path, sys.definition(dir, relayA).text)
    await sys.start(dir)
  }
  return { home, hostHome, sys, mutable, manager, upgrade, standalone }
}
test('explicit first install persists both components, private identity and user encoder; pairing and setup are explicit', async (t) => {
  const f = await fixture(t),
    m = f.manager()
  m.start()
  await m.close()
  assert.equal((await m.handle({ action: 'status' })).enabled, false)
  assert.equal(f.mutable.starts, 0)
  await assert.rejects(m.handle({ action: 'pair' }), /Enable/)
  let s = await m.handle({ action: 'enable', relay: relayA })
  assert(s.enabled && s.managed && s.running && s.online && s.control)
  assert.equal(f.mutable.installs, 2)
  assert.equal(f.mutable.pairs, 0)
  const text = await f.sys.plist(f.hostHome)
  assert(text.includes(f.home) && text.includes('GODBOT_DESKTOP_FFMPEG') && text.includes('bundled-encoder'))
  assert((await m.handle({ action: 'pair' })).offer.uri)
  await m.handle({ action: 'open-permissions' })
  assert.equal(f.mutable.permissions, 1)
  const before = await readFile(join(f.hostHome, 'identity.json'))
  s = await m.handle({ action: 'disable' })
  assert(!s.enabled && !s.running && s.installed)
  assert.deepEqual(await readFile(join(f.hostHome, 'identity.json')), before)
})
test('legacy standalone adoption waits for pending or active sessions, including deferred disable', async (t) => {
  const f = await fixture(t)
  await f.standalone('0.1.1')
  f.mutable.modern = false
  const m = f.manager()
  f.mutable.sessions = [{ state: 'pending' }]
  const status = await m.handle({ action: 'enable' })
  assert(status.enabled && !status.managed && status.busy && status.pendingAction === 'enable')
  assert.equal(f.mutable.stops, 0)
  f.mutable.sessions = []
  await m.reconcile()
  assert.equal((await m.status()).installedVersion, '0.1.2')
  assert.equal((await m.status()).relay, relayA)
  f.mutable.sessions = [{ state: 'approved' }]
  const deferred = await m.handle({ action: 'disable' })
  assert.equal(deferred.pendingAction, 'disable')
  assert(deferred.running)
  f.mutable.sessions = []
  await m.reconcile()
  assert(!(await m.status()).running)
})
test('per-user lock coordinates two profiles, no duplicate installs; newer standalone remains on disk', async (t) => {
  const f = await fixture(t),
    a = f.manager(),
    b = f.manager()
  await Promise.all([
    a.handle({ action: 'enable', relay: relayA }),
    b.handle({ action: 'enable', relay: relayA }),
  ])
  assert.equal(f.mutable.installs, 2)
  assert.equal(f.mutable.starts, 1)
  const latest = f.upgrade('0.1.3')
  await latest.reconcile()
  assert.equal(f.mutable.installs, 4)
  const older = f.upgrade('0.1.2')
  await older.reconcile()
  assert.equal(f.mutable.installs, 4)
  assert.equal((await older.status()).installedVersion, '0.1.3')
})
test('late session admission postpones replacement; failed add-on or relay startup restores both links, service, identity and plist', async (t) => {
  const f = await fixture(t),
    m = f.manager()
  await m.handle({ action: 'enable', relay: relayA })
  const prior = await f.sys.installed()
  const config = await readFile(join(f.hostHome, 'identity.json'), 'utf8'),
    plist = await f.sys.plist(f.hostHome)
  const updated = f.upgrade('0.1.3')
  f.mutable.fenceBusy = true
  await updated.reconcile()
  assert.equal(f.mutable.stops, 0)
  f.mutable.fenceBusy = false
  f.mutable.failComponent = 'desktop'
  await assert.rejects(updated.reconcile(), /component failure/)
  delete f.mutable.failComponent
  assert.deepEqual(await f.sys.installed(), prior)
  assert.equal(await f.sys.plist(f.hostHome), plist)
  assert.equal(await readFile(join(f.hostHome, 'identity.json'), 'utf8'), config)
  f.mutable.failReady = true
  await assert.rejects(updated.handle({ action: 'enable', relay: relayB }), /Test start failure/)
  assert(f.mutable.loaded)
  assert.deepEqual(await f.sys.installed(), prior)
  assert.equal(await f.sys.plist(f.hostHome), plist)
  assert.equal(await readFile(join(f.hostHome, 'identity.json'), 'utf8'), config)
  await updated.reconcile()
  assert.equal((await updated.status()).installedVersion, '0.1.3')
})
test('rejects unexpected publisher and unsupported platforms without launching anything', async (t) => {
  const f = await fixture(t),
    m = f.manager()
  await f.standalone('0.1.2')
  await writeFile(join(f.sys.store, 'publisher.pem'), 'untrusted')
  await assert.rejects(m.handle({ action: 'enable' }), /another publisher/)
  const other = new BundledComputerHost({ platform: 'linux', home: f.home })
  assert.equal((await other.handle({ action: 'status' })).supported, false)
  await assert.rejects(other.handle({ action: 'enable' }), /Apple silicon/)
  assert.equal(f.mutable.stops, 0)
})
test('maintenance rejects terminal and a desktop request racing an asynchronous permission probe', async () => {
  let resolveProbe,
    maintenance = false
  const sessions = new MachineSessions({
    name: 'QA',
    audit() {},
    grants: () => ['terminal', 'desktop.view'],
    maintaining: () => maintenance,
    desktop: {
      probe: () =>
        new Promise((r) => {
          resolveProbe = r
        }),
    },
  })
  const peer = { deviceId: 'controller', tunnelId: 'one', signal: new AbortController().signal }
  const opening = sessions.open({ mode: 'desktop', requestId: 'display-first' }, peer)
  maintenance = true
  resolveProbe({ available: true })
  await assert.rejects(opening, (e) => e.code === 'BUSY')
  await assert.rejects(
    sessions.open({ mode: 'terminal', requestId: 'terminal-second' }, peer),
    (e) => e.code === 'BUSY',
  )
  assert.equal(sessions.records.size, 0)
  await sessions.stop()
})

test('an older profile preserves a newer content-addressed encoder for the same standalone release', async t => {
  const f = await fixture(t)
  const original = f.sys.bundle
  const owner = f.manager()
  owner.managerVersion = '0.2.0-rc.28'
  await owner.handle({ action: 'enable', relay: relayA })
  const bytes = Buffer.from('new pinned encoder')
  f.sys.bundle = {
    ...original,
    encoder: () => ({ sha256: sha(bytes) }),
    copyEncoder: dest => writeFile(dest, bytes, { mode: 0o700 }),
  }
  const newer = f.manager()
  newer.managerVersion = '0.2.0-rc.29'
  await newer.reconcile()
  const selected = await f.sys.plist(f.hostHome)
  assert(selected.includes(sha(bytes)))
  const restarts = f.mutable.starts
  f.sys.bundle = original
  await owner.reconcile()
  assert.equal(await f.sys.plist(f.hostHome), selected)
  assert.equal(f.mutable.starts, restarts)
})

test('recovery from an interrupted transaction preserves an independently installed newer signed release', async t => {
  const f = await fixture(t)
  const owner = f.manager()
  await owner.handle({ action: 'enable', relay: relayA })
  const before = await owner.read()
  await f.sys.snapshot(f.hostHome, true, before, { host: 'releases/host-0.1.3-darwin-arm64-000000000000' })
  await f.standalone('0.1.4')
  await owner.reconcile()
  assert.equal((await owner.status()).installedVersion, '0.1.4')
  assert.equal(await maybe(readFile(join(owner.transaction, 'journal.json'))), undefined)
})
