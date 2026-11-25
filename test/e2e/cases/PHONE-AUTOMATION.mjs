// A packaged Godbot and APK share the same automation plans over a real test relay.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { openFullTeam, openSettingsPage } from '../native-ui.mjs'
import { startRelay } from '../phone-relay.mjs'

export default async function check({ makeHost, candidate, reportDir, scratch, note }) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('Set GODBOT_ANDROID_E2E to the Android checkout')
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1') throw new EnvironmentError('Select a test Android emulator')
  const relay = await startRelay(scratch, note)
  const port = new URL(relay.url).port
  let reversed = false
  const tap = async (what, ...names) => ui.tap(await ui.waitFor(nodes => ui.find(nodes, ...names), what))
  async function fill(text, ...names) {
    ui.tap(await ui.scrollTo(nodes => ui.field(nodes, ...names), names[0]))
    await ui.sleep(350)
    ui.typeText(text)
    await ui.hideKeyboard()
  }
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    await openFullTeam(host)
    const team = await host.bot('state')
    const main = team.bots.find(bot => bot.id === team.mainBotId)
    const call = (action, args = {}) => host.rpc('dispatch', { request: { action: 'automation.setup.' + action, ...args } })
    const messageTitle = 'Shared conversation reminder'
    const scheduled = await host.bot('schedule-create', { target: main.id, title: messageTitle,
      prompt: 'Return the fixture reminder', when: { kind: 'every', minutes: 720 } })
    const reminder = scheduled.tasks.find(task => task.title === messageTitle)
    assert.ok(reminder)

    async function phone(endpoint, payload = {}) {
      const response = await host.page.context().request.post(host.url + '/api/godbot/team', {
        data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15_000,
      })
      const frame = await response.json()
      assert.ok(response.ok() && frame.ok, endpoint + ': ' + JSON.stringify(frame.error ?? response.status()))
      return frame.value
    }
    await phone('phone-set', { server: relay.url, on: true })
    await until(async () => (await phone('phone-set')).status === 'online', 'computer online at the real relay')
    const { pairing } = await phone('phone-pair')
    ui.install(process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk'))
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    reversed = true
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.openUrl(pairing.uri)
    await tap('pair test computer', 'Pair', '配对')
    await ui.waitFor(nodes => nodes.some(n => n.cls.endsWith('EditText')), 'the first chat', { timeout: 60_000 })
    await tap('open team list', 'Open team list', '打开团队列表')
    await tap('Automation entry', 'Automation', '自动化')
    await ui.waitFor(nodes => ui.find(nodes, messageTitle), 'existing Web schedule on the phone')

    await tap('start creating an automation', 'New automation', '新建自动化')
    await tap('choose Bot assignment', 'Bot assignment', 'Bot 派工')
    await tap('open target list', /^Target(?:,|$)/u, /^执行对象(?:,|，|$)/u)
    await tap('select main Bot', main.name)
    const title = 'Android assignment round trip'
    await fill(title, 'Automation name', '自动化名称')
    await fill('Return a round-trip fixture result', 'Instructions and acceptance criteria', '执行要求与验收条件')
    ui.tap(await ui.scrollTo(nodes => ui.find(nodes, 'Create automation', '创建自动化'), 'the create button'))
    const assignment = await until(async () => (await call('view')).items.find(item => item.title === title), 'Android write stored on the Web host')
    assert.equal(assignment.target.id, main.id)
    assert.equal(assignment.source, 'routine')
    assert.equal(assignment.trigger.when.kind, 'daily')
    await ui.waitFor(nodes => ui.find(nodes, title), 'the assignment in the Android list')
    await writeFile(join(reportDir, 'android-automation.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))

    await openSettingsPage(host, /^(自动化|Automation)$/u)
    const page = host.page.getByRole('region', { name: /^(自动化|Automation)$/u })
    const row = page.getByRole('article', { name: title })
    await page.getByRole('article', { name: messageTitle }).waitFor()
    await row.locator('.gb-auto-row').click()
    await row.getByRole('button', { name: /^(暂停|Pause)$/u }).click()
    await row.getByText(/^(已暂停|Paused)$/u).waitFor()
    await tap('the assignment on the phone', title)
    await ui.waitFor(nodes => ui.find(nodes, 'Resume automation', '恢复'), 'the Web pause reflected on Android')
    await tap('resume the assignment on Android', 'Resume automation', '恢复')
    await row.getByRole('button', { name: /^(暂停|Pause)$/u }).waitFor({ timeout: 20_000 })
    const status = (await call('view')).items.find(item => item.id === assignment.id)
    assert.equal(status.status, 'active')
    assert.equal((await call('view')).items.find(item => item.id === reminder.id).target.id, main.id)
    await host.capture('web-automation-cross-client')
    note('automation-round-trip', { assignmentId: assignment.id, reminderId: reminder.id, target: main.id,
      phoneCreated: true, webPaused: true, phoneResumed: true, status: status.status })
  } finally {
    try {
      if (reversed) ui.adb(['reverse', '--remove', 'tcp:' + port])
    } finally {
      await relay.close()
    }
  }
}
