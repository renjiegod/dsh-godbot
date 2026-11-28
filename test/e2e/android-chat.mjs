import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { until } from './host.mjs'
import { startRelay } from './phone-relay.mjs'

export async function channel(host, endpoint, payload = {}) {
  const response = await host.page.context().request.post(host.url + '/api/godbot/team', {
    data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15_000,
  })
  const result = await response.json()
  assert.ok(response.ok() && result.ok, endpoint + ': ' + JSON.stringify(result.error))
  return result.value
}

export async function withAndroidBotChat(context, host, bot, visit) {
  const app = process.env.GODBOT_ANDROID_E2E
  const apk = process.env.GODBOT_E2E_APK
  if (!app || !apk) return
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  assert.equal(ui.shell('getprop ro.kernel.qemu').trim(), '1', 'use an isolated emulator')
  const relay = await startRelay(context.scratch, context.note)
  const port = new URL(relay.url).port
  let forwarded = false
  try {
    await channel(host, 'phone-set', { server: relay.url, on: true })
    await until(async () => (await channel(host, 'phone-set')).status === 'online', 'host connected to the Android test relay')
    const { pairing } = await channel(host, 'phone-pair')
    ui.install(apk)
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    forwarded = true
    ui.openUrl(pairing.uri)
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Pair', '配对'), 'pair the test APK'))
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Open team list', '打开团队列表'), 'open the Android team list'))
    ui.tap(await ui.waitFor(nodes => nodes.find(node => node.text === bot.name && node.bounds.x1 < 700)
      ?? nodes.find(node => node.clickable && node.desc.startsWith(bot.name + ',')), 'open the paired Bot conversation'))
    await visit(ui)
  } finally {
    try {
      if (forwarded) ui.adb(['reverse', '--remove', 'tcp:' + port], { timeout: 5000 })
    } finally { await relay.close() }
  }
}
