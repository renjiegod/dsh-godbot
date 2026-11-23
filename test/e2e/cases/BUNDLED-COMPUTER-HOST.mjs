import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localRequest } from '../../../computer-host/local.js'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { startRelay } from '../phone-relay.mjs'

const named = (english, chinese) => new RegExp('^(?:' + english + '|' + chinese + ')$', 'u')

async function machines(host) {
  await openFullTeam(host)
  await host.page.getByRole('button', { name: named('Remote computers', '远程电脑') }).click()
  return host.page.getByRole('dialog', { name: named('Remote computers', '远程电脑') })
}

export default async function bundledComputerHost({ makeHost, candidate, scratch, note }) {
  const dir = await mkdtemp(join(scratch, 'single-install-'))
  const targetHome = join(dir, 'target')
  const relay = await startRelay(dir, note)
  const target = await makeHost({ env: { GODBOT_COMPUTER_HOME: targetHome } })
  const account = join(target.root, 'account')
  const root = join(account, '.local/share/godbot-computer')
  const launcher = join(account, '.local/bin/godbot-computer')
  const label = 'io.github.godbot.computer.' + createHash('sha256').update(targetHome).digest('hex').slice(0, 12)
  const plist = join(account, 'Library/LaunchAgents', label + '.plist')
  const local = (action, details = {}) => target.rpc('godbot/machineHost', { request: { action, ...details } })
  try {
    assert.ok(!existsSync(root) && !existsSync(launcher), 'the fixture has no standalone installation')
    await target.install(candidate)
    // Capture only the test offer in an isolated browser context, without changing the OS clipboard.
    await target.page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: {
        async writeText(value) { globalThis.fixturePairingOffer = value },
      } })
    })
    await target.start()
    const status = await local('status')
    assert.equal(status.supported, true)
    assert.equal(status.enabled, false)
    assert.equal(status.running, false)
    assert.ok(!existsSync(launcher), 'installing the plugin does not enable incoming access')
    const anonymous = await fetch(target.url + '/api/godbot/machineHost', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: target.url },
      body: JSON.stringify({ type: 'client-request', method: 'godbot/machineHost',
        rpcId: randomUUID(), payload: { args: { request: { action: 'enable', relay: relay.url } } } }),
    })
    assert.equal(anonymous.status, 401)
    assert.ok(!existsSync(launcher), 'anonymous setup cannot enable a host')

    const panel = await machines(target)
    await panel.getByRole('button', { name: named('This computer', '本机') }).click()
    const setup = panel.getByRole('region', { name: named('This computer', '本机') })
    await setup.getByLabel(named('Relay server', '中继服务器')).fill(relay.url)
    await setup.getByRole('button', { name: named('Enable remote access', '开启远程访问') }).click()
    const active = await until(async () => {
      const state = await local('status')
      return state.enabled && state.managed && state.running && state.online ? state : null
    }, 'Godbot installed and started the bundled Mac host', 45_000)

    const [core, desktop] = await Promise.all(['current', 'desktop-current'].map(async entry =>
      JSON.parse(await readFile(join(root, entry, 'manifest.json'), 'utf8')),
    ))
    assert.equal(core.version, active.bundledVersion)
    assert.equal(core.version, active.installedVersion)
    assert.equal(desktop.version, core.version)
    assert.ok(existsSync(launcher))
    execFileSync('/usr/bin/codesign', [
      '--verify', '--strict', '-R=identifier "io.github.renjiegod.godbot.computerhost"',
      join(root, 'desktop-current', 'native', 'Godbot Computer Host.app'),
    ])
    const env = await readFile(plist, 'utf8')
    const encoder = env.match(/<key>GODBOT_DESKTOP_FFMPEG<\/key>\s*<string>([^<]+)<\/string>/u)?.[1]
    assert.ok(encoder?.startsWith(root + '/') && existsSync(encoder), 'the service uses the bundled encoder')

    await setup.getByRole('button', { name: /^(?:Create pairing link|创建配对链接|生成配对链接)$/u }).click()
    await setup.getByRole('button', { name: named('Copy pairing link', '复制配对链接') }).click()
    let offer = await until(() => target.page.evaluate(() => globalThis.fixturePairingOffer), 'copy the isolated pairing offer')
    assert.ok(typeof offer === 'string' && offer.startsWith('godbot:'))
    assert.ok(!(await target.page.locator('body').innerText()).includes(offer))

    const controller = await makeHost()
    await controller.install(candidate)
    await controller.start()
    const viewer = await machines(controller)
    const pair = viewer.getByRole('button', { name: named('Pair computer', '配对电脑') })
    await pair.last().click()
    await viewer.getByLabel(named('Pairing offer', '配对链接')).fill(offer)
    offer = undefined
    await viewer.getByRole('button', { name: named('Review offer', '检查配对信息') }).click()
    await viewer.getByText(named('Trust this computer\\?', '信任这台电脑？')).waitFor()
    await pair.last().click()
    const terminalButton = viewer.getByRole('button', { name: named('Open terminal', '打开终端') })
    await terminalButton.waitFor()
    const [enrolled] = await localRequest(targetHome, 'controllers')
    assert.ok(enrolled, 'the controller was enrolled through the service')
    assert.deepEqual(enrolled.grants, [], 'pairing starts with no remembered grants')
    // The owner approves only this disposable controller and scope, without a desktop prompt.
    await localRequest(targetHome, 'grant', [enrolled.deviceId ?? enrolled.id, 'terminal'])
    await terminalButton.click()
    await controller.page.getByRole('alertdialog').getByRole('button', { name: named('Continue', '继续') }).click()
    const shell = viewer.locator('.xterm-helper-textarea')
    await shell.waitFor()
    const proof = join(dir, 'pty-proof')
    const marker = randomUUID()
    await shell.focus()
    await controller.page.keyboard.type("printf '%s' '" + marker + "' > '" + proof + "'")
    await controller.page.keyboard.press('Enter')
    await until(async () => (await readFile(proof, 'utf8').catch(() => '')) === marker, 'native Mac PTY executed a browser command')

    const before = await localRequest(targetHome, 'status')
    await target.restart()
    const reloaded = await local('status')
    assert.ok(reloaded.enabled && reloaded.running && reloaded.managed)
    const after = await localRequest(targetHome, 'status')
    assert.equal(after.fingerprint, before.fingerprint)
    assert.equal((await localRequest(targetHome, 'controllers')).length, 1)
    assert.equal((await localRequest(targetHome, 'sessions')).some(session => session.state === 'approved'), true)
    note('bundled-computer-host', {
      freshProfile: true, noStandaloneInstaller: true, optedIn: true, anonymousDenied: true, signedDesktop: true,
      nativePty: true, bundledEncoder: true, hostVersion: core.version, controllerPairingPreserved: true,
      serviceAndTerminalSurvivedDshRestart: true,
    })

    await controller.stop()
    await until(async () => !(await localRequest(targetHome, 'sessions')).some(session =>
      session.state === 'pending' || session.state === 'approved' || session.state === 'opening'),
    'browser shutdown released the isolated remote shell')
    const reopened = await machines(target)
    await reopened.getByRole('button', { name: named('This computer', '本机') }).click()
    await reopened.getByRole('button', { name: named('Turn off remote access', '关闭远程访问') }).click()
    await target.page.getByRole('alertdialog').getByRole('button', { name: /^(?:Continue|继续|Turn off remote access|关闭远程访问)$/u }).last().click()
    await until(async () => {
      const state = await local('status')
      return !state.enabled && !state.running
    }, 'turning off disables the managed service')
    assert.ok(!existsSync(plist), 'disabled launch agent will not start again')
    note('bundled-computer-host-disabled', { stopped: true, launchAgentRemoved: true })
  } finally {
    // This unique launchd label belongs only to the disposable target.
    try { execFileSync('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + label], { stdio: 'ignore' }) } catch {}
    await relay.close()
  }
}
