import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { IDLE_MS, RETRY_MS, install, sourceOf } from '../../src/host/team-runtime/core/update.js'
import {
  GITHUB_API, archiveManifest, compatibility, downloadArchive, newer, newestRelease, releasesApi, sidecarDigest,
} from '../../src/host/team-runtime/core/update-release.js'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const [major, minor, patch] = PKG.version.split('-')[0].split('.').map(Number)
// A stable release newer than whatever this checkout is: offered on either channel.
const NEXT = `${major}.${minor}.${patch + 1}`
const REPO = 'renjiegod/dsh-godbot'
const LIST = `https://api.github.com/repos/${REPO}/releases?per_page=30`
const sha = data => createHash('sha256').update(data).digest('hex')

const dirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-update-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// A ustar entry, the way npm pack writes package/package.json.
function tarEntry(name, body, type = '0') {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.fill(' ', 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}
const tgz = entries => gzipSync(Buffer.concat([...entries.map(([name, body, type]) => tarEntry(name, Buffer.from(body), type)), Buffer.alloc(1024)]))
const manifestFor = (version, extra = {}) => JSON.stringify({ name: PKG.name, version, engines: PKG.engines, peerDependencies: PKG.peerDependencies, ...extra })
const archiveFor = (version, extra) => tgz([['package/README.md', '# Godbot\n'], ['package/package.json', manifestFor(version, extra)]])

function release(version, { data = archiveFor(version), digest = true, prerelease = version.includes('-'), draft = false, sidecar = false } = {}) {
  const name = `${PKG.name}-${version}.tgz`
  const url = `https://github.com/${REPO}/releases/download/v${version}/${name}`
  const assets = [{ name, browser_download_url: url, size: data.length, ...(digest ? { digest: `sha256:${sha(data)}` } : {}) }]
  if (sidecar) assets.push({ name: `${name}.sha256`, browser_download_url: `${url}.sha256`, size: 90 })
  return { body: { tag_name: `v${version}`, html_url: `https://github.com/${REPO}/releases/tag/v${version}`, draft, prerelease, assets }, url, data }
}

function fakeNet(routes) {
  const calls = []
  const answer = (url) => {
    calls.push(url)
    const value = typeof routes[url] === 'function' ? routes[url]() : routes[url]
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error(`${url} answered 404`)
    return value
  }
  return {
    calls,
    async json(url) { return answer(url) },
    async text(url) { return String(answer(url)) },
    async download(url, path, { onProgress } = {}) {
      const data = answer(url)
      writeFileSync(path, data, { flag: 'wx' })
      onProgress?.(data.length, data.length)
    },
  }
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

// The team runtime's update module with the profile, plugin manager, network and clock it reads.
function harness({ releases, routes = {}, mode, dsh = PKG.engines.dsh, peers = Object.keys(PKG.peerDependencies), install: answer, home = scratch() } = {}) {
  const profile = scratch()
  const archives = scratch()
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries([...peers.map(name => [name, `link:/dsh/${name}`]), [PKG.name, `file:/old/${PKG.name}-${PKG.version}-000000000000.tgz`]]),
  }))
  const installs = []
  const manager = {
    listBundles: async () => [{ name: PKG.name, source: `file:/old/${PKG.name}-${PKG.version}-000000000000.tgz` }],
    installBundle: async (spec, options) => {
      installs.push({ spec, options })
      return answer ? answer(spec) : { application: 'restart-required', version: NEXT }
    },
  }
  const net = fakeNet({ [LIST]: releases.map(entry => entry.body), ...Object.fromEntries(releases.map(entry => [entry.url, entry.data])), ...routes })
  const clock = { now: 1_000_000_000_000 }
  const warnings = []
  const services = {
    pluginManager: manager,
    profileContext: { dir: profile },
    loader: { import: async () => ({ getDshRuntimeVersion: () => dsh }), unwrapExports: value => value },
  }
  const rt = {
    ctx: { get: name => services[name], effect() {} },
    config: { updateArchiveDir: archives, ...(mode ? { updateMode: mode } : {}) },
    home,
    live: new Map(),
    readOnly: () => undefined,
    warn: (...args) => warnings.push(args),
    updateNet: net,
    updateClock: () => clock.now,
  }
  install(rt)
  return { rt, net, clock, installs, archives, home, warnings, manager }
}

test('a packed archive install updates from GitHub releases; a folder or link does not', () => {
  assert.equal(sourceOf('file:/Users/me/.local/share/dsh-godbot/packages/dsh-godbot-0.2.0-abc.tgz').kind, 'archive')
  assert.equal(sourceOf('/tmp/dsh-godbot-0.2.0.tar.gz').kind, 'archive')
  assert.equal(sourceOf('link:/Users/me/code/dsh-godbot').kind, 'path')
  assert.equal(sourceOf('file:/Users/me/code/dsh-godbot').kind, 'path')
  assert.equal(sourceOf('dsh-godbot@0.2.0').kind, 'registry')
  assert.equal(sourceOf('github:renjiegod/dsh-godbot#v0.2.0').kind, 'git')
  assert.equal(sourceOf('https://example.com/dsh-godbot-0.2.0.tgz').kind, 'tarball')
})

test('the newest release carrying the archive wins, prereleases only on that channel', async () => {
  const stable = release('0.3.0')
  const rc = release('0.4.0-rc.1')
  const draft = release('0.5.0', { draft: true })
  const bare = { body: { tag_name: 'v0.6.0', draft: false, prerelease: false, assets: [] } }
  const net = fakeNet({ [LIST]: [rc.body, draft.body, bare.body, stable.body] })
  const found = await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net })
  assert.equal(found.version, '0.3.0')
  assert.equal(found.asset.sha256, sha(stable.data))
  assert.equal(found.notesUrl, stable.body.html_url)
  assert.equal((await newestRelease({ repo: REPO, name: PKG.name, prerelease: true, net })).version, '0.4.0-rc.1')
  assert.equal(await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [LIST]: [] }) }), null)
})

test('GODBOT_UPDATE_API points the release list at another server', async () => {
  assert.equal(releasesApi({}), GITHUB_API)
  assert.equal(releasesApi({ GODBOT_UPDATE_API: 'file:///etc/passwd' }), GITHUB_API)
  assert.equal(releasesApi({ GODBOT_UPDATE_API: 'http://127.0.0.1:9000/' }), 'http://127.0.0.1:9000/')
  const local = 'http://127.0.0.1:9000/repos/renjiegod/dsh-godbot/releases?per_page=30'
  assert.equal(await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [local]: [] }), api: 'http://127.0.0.1:9000/' }), null)
})

test('a release without GitHub\'s digest needs a .sha256 beside its archive', async () => {
  const withSidecar = release('0.3.0', { digest: false, sidecar: true })
  const sum = `${sha(withSidecar.data)}  ${PKG.name}-0.3.0.tgz\n`
  const found = await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [LIST]: [withSidecar.body], [`${withSidecar.url}.sha256`]: sum }) })
  assert.equal(found.asset.sha256, sha(withSidecar.data))
  assert.equal(sidecarDigest('not-a-hash file'), null)
  const unvouched = release('0.3.0', { digest: false })
  await assert.rejects(newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [LIST]: [unvouched.body] }) }), /states no SHA-256/)
})

test('an archive is kept only when its bytes match the release', async () => {
  const dir = scratch()
  const good = Buffer.from('archive bytes')
  const asset = { url: 'https://example.com/a.tgz', size: good.length, sha256: sha(good) }
  const path = await downloadArchive({ dir, name: PKG.name, version: '9.9.9', asset, net: fakeNet({ [asset.url]: good }) })
  assert.equal(path, join(dir, `${PKG.name}-9.9.9-${asset.sha256.slice(0, 12)}.tgz`))
  // Present with the same hash: used as it is, not fetched again.
  const offline = fakeNet({})
  assert.equal(await downloadArchive({ dir, name: PKG.name, version: '9.9.9', asset, net: offline }), path)
  assert.deepEqual(offline.calls, [])
  const tampered = { ...asset, sha256: sha(Buffer.from('something else')) }
  await assert.rejects(downloadArchive({ dir, name: PKG.name, version: '9.9.8', asset: tampered, net: fakeNet({ [asset.url]: good }) }), /does not match/)
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('9.9.8')), [])
})

test('the manifest is read from inside the archive, long names included', () => {
  const dir = scratch()
  const plain = join(dir, 'plain.tgz')
  writeFileSync(plain, archiveFor('1.2.3'))
  assert.equal(archiveManifest(plain).version, '1.2.3')
  const pax = join(dir, 'pax.tgz')
  writeFileSync(pax, tgz([['PaxHeader/x', '30 path=package/package.json\n', 'x'], ['package/ignored-short-name', manifestFor('1.2.4')]]))
  assert.equal(archiveManifest(pax).version, '1.2.4')
  const empty = join(dir, 'empty.tgz')
  writeFileSync(empty, tgz([['package/README.md', 'no manifest']]))
  assert.throws(() => archiveManifest(empty), /no package\/package.json/)
})

test('an archive installs only for the running DSH and the peers the profile links', () => {
  const want = { name: PKG.name, version: '1.0.0', dsh: '0.2.2', linked: ['@deepseek-ai/dsh-web'] }
  const manifest = { name: PKG.name, version: '1.0.0', engines: { dsh: '0.2.2' }, peerDependencies: { '@deepseek-ai/dsh-web': '0.2.2' } }
  assert.equal(compatibility(manifest, want), null)
  assert.deepEqual(compatibility({ ...manifest, engines: { dsh: '0.3.0' } }, want), { reason: 'dsh', dsh: '0.3.0', current: '0.2.2' })
  assert.deepEqual(compatibility({ ...manifest, peerDependencies: { '@deepseek-ai/dsh-new': '0.2.2' } }, want), { reason: 'peers', peers: ['@deepseek-ai/dsh-new'] })
  assert.equal(compatibility({ ...manifest, version: '1.0.1' }, want).reason, 'mismatch')
  assert.equal(newer('0.2.0', '0.2.0-rc.3'), true)
  assert.equal(newer('0.2.0-rc.10', '0.2.0-rc.9'), true)
})

test('auto mode downloads a release, waits until Godbot is idle, then installs it', async () => {
  const next = release(NEXT)
  const { rt, clock, installs, archives, home } = harness({ releases: [next] })
  await rt.updateTick()
  await rt.updatePrepare()
  let view = rt.updateView()
  assert.equal(view.source, 'archive')
  assert.equal(view.phase, 'ready')
  assert.equal(view.available, true)
  assert.equal(view.mode, 'auto')
  const archive = join(archives, `${PKG.name}-${NEXT}-${sha(next.data).slice(0, 12)}.tgz`)
  assert.ok(existsSync(archive))

  // A Bot at work holds the install back.
  rt.live.set('bot-1', { turn: { id: 't1' } })
  await rt.updateTick()
  assert.deepEqual(rt.updateView().waiting, [{ kind: 'turns', count: 1 }])
  const stopTerminal = rt.addUpdateBlocker(() => ({ kind: 'terminals', count: 1 }))
  rt.live.clear()
  clock.now += IDLE_MS * 2
  await rt.updateTick()
  assert.deepEqual(rt.updateView().waiting, [{ kind: 'terminals', count: 1 }])
  stopTerminal()
  assert.equal(installs.length, 0)

  // Idle: the first quiet minute starts the wait, IDLE_MS later it installs.
  await rt.updateTick()
  assert.deepEqual(rt.updateView().waiting, [{ kind: 'idle' }])
  clock.now += IDLE_MS
  await rt.updateTick()
  await settle()
  assert.deepEqual(installs.map(entry => entry.spec), [archive])
  view = rt.updateView()
  assert.equal(view.phase, 'installed')
  assert.equal(view.installed, NEXT)
  assert.equal(view.available, false)
  const marker = JSON.parse(readFileSync(join(home, 'update.json'), 'utf8'))
  assert.equal(marker.from, PKG.version)
  assert.equal(marker.to, NEXT)
  assert.equal(marker.auto, true)
})

test('notify mode keeps the downloaded release for a click; off mode only asks when told', async () => {
  const next = release(NEXT)
  const notify = harness({ releases: [next], mode: 'notify' })
  await notify.rt.updateTick()
  await notify.rt.updatePrepare()
  notify.clock.now += IDLE_MS * 3
  await notify.rt.updateTick()
  await notify.rt.updateTick()
  assert.equal(notify.rt.updateView().phase, 'ready')
  assert.equal(notify.installs.length, 0)
  notify.rt.updateStart()
  await settle()
  assert.equal(notify.installs.length, 1)

  const off = harness({ releases: [next], mode: 'off' })
  await off.rt.updateTick()
  assert.deepEqual(off.net.calls, [])
  // A click on Check finds it without downloading; Update downloads and installs.
  const checked = await off.rt.updateCheck({ fresh: true })
  assert.equal(checked.available, true)
  assert.equal(checked.phase, 'idle')
  assert.deepEqual(off.net.calls, [LIST])
  off.rt.updateStart()
  await off.rt.updatePrepare()
  await settle()
  assert.equal(off.installs.length, 1)
  assert.equal(off.rt.updateView().phase, 'installed')
})

test('the update mode is kept in the data folder', async () => {
  const home = scratch()
  const first = harness({ releases: [], home })
  assert.equal(first.rt.updateSettings({ mode: 'notify' }).mode, 'notify')
  assert.throws(() => first.rt.updateSettings({ mode: 'sometimes' }), /auto, notify or off/)
  assert.equal(harness({ releases: [], home }).rt.updateView().mode, 'notify')
})

test('a release built for another DSH is shown but never installed', async () => {
  const next = release(NEXT, { data: archiveFor(NEXT, { engines: { dsh: '9.9.9' } }) })
  const { rt, clock, installs } = harness({ releases: [next] })
  await rt.updateTick()
  await rt.updatePrepare()
  const view = rt.updateView()
  assert.deepEqual(view.blocked, { reason: 'dsh', dsh: '9.9.9', current: PKG.engines.dsh })
  assert.equal(view.available, false)
  clock.now += IDLE_MS * 3
  await rt.updateTick()
  await rt.updateTick()
  assert.equal(installs.length, 0)
  assert.throws(() => rt.updateStart(), /needs DSH 9\.9\.9/)
})

test('a failed download is tried again later; a failed automatic install is not', async () => {
  const next = release(NEXT)
  let broken = true
  const { rt, clock, installs, net } = harness({
    releases: [next],
    routes: { [next.url]: () => (broken ? Buffer.from('corrupted') : next.data) },
    install: () => ({ error: { code: 'pnpm-failed', diagnostic: 'pnpm exited 1' } }),
  })
  await rt.updateTick()
  await rt.updatePrepare()
  assert.equal(rt.updateView().phase, 'failed')
  broken = false
  clock.now += 60_000
  await rt.updateTick()
  assert.equal(net.calls.filter(url => url === next.url).length, 1)
  clock.now += RETRY_MS
  await rt.updateTick()
  await rt.updatePrepare()
  assert.equal(rt.updateView().phase, 'ready')

  await rt.updateTick()
  clock.now += IDLE_MS
  await rt.updateTick()
  await settle()
  assert.equal(installs.length, 1)
  assert.equal(rt.updateView().phase, 'failed')
  clock.now += IDLE_MS * 5
  await rt.updateTick()
  await rt.updateTick()
  assert.equal(installs.length, 1)
})

// A download that hangs until it is stopped, for the release at `url`.
function hangOn(net, url) {
  const download = net.download
  net.download = (target, path, options) => target === url
    ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    : download(target, path, options)
}

test('turning updates off stops a download without calling it a failure', async () => {
  const next = release(NEXT)
  const { rt, net } = harness({ releases: [next] })
  hangOn(net, next.url)
  await rt.updateTick()
  assert.equal(rt.updateView().phase, 'downloading')
  const pending = rt.updatePrepare()
  assert.equal(rt.updateSettings({ mode: 'off' }).phase, 'idle')
  await pending
  const view = rt.updateView()
  assert.equal(view.phase, 'idle')
  assert.equal(view.error, null)
  assert.equal(view.available, true)
})

test('a newer release found mid-download replaces the one being fetched', async () => {
  const next = release(NEXT)
  const later = release(`${major}.${minor}.${patch + 2}`)
  const { rt, net, archives } = harness({ releases: [next], routes: { [later.url]: later.data } })
  hangOn(net, next.url)
  await rt.updateTick()
  assert.equal(rt.updateView().phase, 'downloading')
  net.json = async () => [later.body, next.body]
  await rt.updateCheck({ fresh: true })
  await rt.updatePrepare()
  const view = rt.updateView()
  assert.equal(view.latest, later.body.tag_name.slice(1))
  assert.equal(view.phase, 'ready')
  assert.deepEqual(readdirSync(archives).filter(name => name.endsWith('.tgz')), [`${PKG.name}-${view.latest}-${sha(later.data).slice(0, 12)}.tgz`])
})

test('the start that runs the new version reports the update', () => {
  const home = scratch()
  writeFileSync(join(home, 'update.json'), JSON.stringify({ from: '0.0.1', to: PKG.version }))
  const { rt } = harness({ releases: [], home })
  assert.equal(rt.updateView().phase, 'updated')
  assert.equal(existsSync(join(home, 'update.json')), false)

  // Installed but not restarted yet: the old version does not install it again.
  writeFileSync(join(home, 'update.json'), JSON.stringify({ from: PKG.version, to: NEXT }))
  const waiting = harness({ releases: [], home })
  assert.equal(waiting.rt.updateView().phase, 'installed')
  assert.equal(waiting.rt.updateView().installed, NEXT)
  assert.equal(existsSync(join(home, 'update.json')), true)
})
