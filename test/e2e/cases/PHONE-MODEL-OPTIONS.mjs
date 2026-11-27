import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { startRelay } from '../phone-relay.mjs'

// A Codex Bot's speed across clients: Android picks Fast in the Bot's model sheet, the
// host saves it and the Web header shows the bolt; the Web resets it and Android reads
// the agent's default again.
export default async function phoneModelOptions({ makeHost, reportDir, scratch, candidate, note }) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('Set GODBOT_ANDROID_E2E to the Android checkout')
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1') throw new EnvironmentError('Select a disposable Android emulator')
  const apk = process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk')
  const relay = await startRelay(scratch, note)
  const port = new URL(relay.url).port
  const tap = async (why, check) => ui.tap(await ui.waitFor(check, why, { timeout: 60_000 }))
  const named = (...names) => nodes => nodes.find(node => node.clickable && names.includes(node.desc))
  let reversed = false
  try {
    const host = await makeHost()
    const fixture = new URL('../../external/fixtures/fake-codex.mjs', import.meta.url)
    await writeFile(join(host.bin, 'codex'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('codex-cli 0.172.0 fixture');
else if (process.argv.includes('status')) console.log('Logged in using ChatGPT');
else import(${JSON.stringify(fixture.href)}).catch(error => { console.error(error); process.exitCode = 1; });
`, { mode: 0o700 })
    await host.install(candidate)
    await host.start()
    await openFullTeam(host)
    const bot = await host.bot('create-bot', { name: 'Paired Speed Tester', model: 'local-codex-cli/gpt-5.1-codex' })
    await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'Bot greeting on test host')
    const speedOf = async () => (await host.bot('state')).bots.find(entry => entry.id === bot.id)?.modelOptions?.speed
    async function phone(endpoint, payload = {}) {
      const response = await host.page.context().request.post(host.url + '/api/godbot/team', {
        data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15_000,
      })
      const frame = await response.json()
      assert.ok(response.ok() && frame.ok, endpoint)
      return frame.value
    }
    await phone('phone-set', { server: relay.url, on: true })
    await until(async () => (await phone('phone-set')).status === 'online', 'the test host connects to the relay')
    const { pairing } = await phone('phone-pair')
    ui.install(apk)
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    reversed = true
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.openUrl(pairing.uri)
    await tap('pair Android to the isolated host', nodes => ui.find(nodes, 'Pair', '配对'))
    await ui.waitFor(nodes => nodes.some(node => node.cls.endsWith('EditText')), 'the paired chat', { timeout: 60_000 })
    await tap('open the Android team', nodes => ui.find(nodes, 'Open team list', '打开团队列表'))
    await tap('select the Codex Bot on Android', nodes => ui.find(nodes, bot.name, new RegExp('^' + bot.name + ',')))
    await ui.waitFor(nodes => !ui.find(nodes, 'Close team list', '关闭团队列表'), 'the team list to close')
    // The chat header opens the Bot's details, whose model trigger opens the sheet.
    await tap('open the Bot details', nodes => nodes.find(node => node.clickable && (node.desc === bot.name || node.desc.startsWith(bot.name + ', '))))
    await ui.waitFor(nodes => ui.find(nodes, 'Edit Bot', '编辑 Bot'), 'the Bot details', { timeout: 60_000 })
    await tap('open the model sheet', named('Model', '模型'))
    // The sheet reads the CLI's catalog: the model's speeds appear once it has.
    await tap('pick Fast on Android', named('Fast', '快速'))
    await until(async () => (await speedOf()) === 'fast', 'the host saved the Android pick')
    await ui.waitFor(nodes => ui.find(nodes, '2x speed, increased usage', '2 倍速度，用量增加'), 'Android shows the Fast description')
    await writeFile(join(reportDir, 'android-model-options-fast.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))

    // The Web reads the Android write, then resets it.
    await openBotChat(host, bot)
    await host.page.locator('.gb-bot-model .bt-speed-mark').waitFor()
    await host.page.locator('[data-gb-bot-model]').click()
    const speed = host.page.locator('.bt-drawer-model .bt-mo[data-option=speed]')
    assert.equal(await speed.getByRole('radio', { name: '快速' }).getAttribute('aria-checked'), 'true')
    await host.capture('web-reads-android-speed')
    await speed.locator('.bt-mo-reset').click()
    await until(async () => (await speedOf()) === undefined, 'the Web reset reached the host')

    // Android reads the reset: its trigger no longer names a faster speed.
    ui.shell('input keyevent KEYCODE_BACK')
    const caption = nodes => nodes.find(node => /^Codex CLI · /u.test(node.text))
    const shown = await ui.waitFor(nodes => {
      const line = caption(nodes)
      return line && !/快速|Fast/u.test(line.text) && line
    }, 'Android reads the Web reset', { timeout: 60_000 })
    note('paired-model-options', { appPicked: 'fast', webRead: true, webReset: true, appCaption: shown.text })
  } finally {
    try { if (reversed) ui.adb(['reverse', '--remove', 'tcp:' + port]) } finally { await relay.close() }
  }
}
