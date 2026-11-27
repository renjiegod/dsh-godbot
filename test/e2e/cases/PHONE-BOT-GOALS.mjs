import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { startRelay } from '../phone-relay.mjs'

export default async function phoneBotGoals({ makeHost, candidate, reportDir, scratch, note }) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('Set GODBOT_ANDROID_E2E to the Android checkout')
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1') throw new EnvironmentError('Select a disposable Android emulator')
  const apk = process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk')
  const previous = process.env.GODBOT_E2E_PREVIOUS_APK
  const relay = await startRelay(scratch, note)
  const port = new URL(relay.url).port
  const tap = async (why, ...names) => ui.tap(await ui.waitFor(nodes => ui.find(nodes, ...names), why, { timeout: 60_000 }))
  const objective = 'Verify the goal on two clients.'
  const evidence = 'Paired fixture evidence.'
  let reversed = false
  let release
  const gate = new Promise(resolve => { release = resolve })
  try {
    const host = await makeHost()
    const attempts = new Map()
    host.model.reply = async ({ messages }) => {
      const blocks = messages.flatMap(row => row.content)
      const text = blocks.findLast(block => block.text?.startsWith('[Godbot goal turn]'))?.text
      const id = /attempt_id "([^"]+)"/u.exec(text ?? '')?.[1]
      if (!id) return 'Goal fixture ready.'
      if (blocks.some(block => block.type === 'tool_use' && block.name === 'report_bot_goal' && block.input?.attempt_id === id)) return 'Cross-client checkpoint recorded.'
      if (!attempts.has(id)) attempts.set(id, attempts.size + 1)
      const first = attempts.get(id) === 1
      if (first) await gate
      return [{ type: 'tool_use', name: 'report_bot_goal', input: { attempt_id: id,
        status: first ? 'progress' : 'complete', summary: first ? 'Finished the first check.' : 'Both clients verified.',
        ...(first ? { next: 'Run the second check.' } : { evidence }) } }]
    }
    await host.install(candidate)
    await host.start()
    await openFullTeam(host)
    const bot = await host.bot('create-bot', { name: 'Paired Goal Tester', model: 'deepseek-official/deepseek-flash' })
    const sessionId = bot.sessionId ?? bot.id
    const params = { botId: bot.id, sessionId }
    const read = () => host.bot('bot-goal-get', params).then(value => value.goal)
    await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'Bot greeting on test host')
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
    ui.install(previous || apk)
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    reversed = true
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.openUrl(pairing.uri)
    await tap('pair Android to the isolated host', 'Pair', '配对')
    await ui.waitFor(nodes => nodes.some(node => node.cls.endsWith('EditText')), 'the paired chat', { timeout: 60_000 })
    await tap('open the Android team', 'Open team list', '打开团队列表')
    await tap('select the goal Bot on Android', bot.name, new RegExp('^' + bot.name + ','))
    if (previous) {
      const installed = () => /firstInstallTime=(.*)/u.exec(ui.shell('dumpsys package ' + ui.PACKAGE))?.[1]
      const before = installed()
      assert.ok(before, 'the previous APK is installed')
      ui.install(apk)
      assert.equal(installed(), before, 'Android updated the existing app in place')
      ui.adb(['shell', 'monkey', '-p', ui.PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1'])
      await ui.waitFor(nodes => ui.find(nodes, 'Message ' + bot.name, '给 ' + bot.name + ' 发消息')
        ?? nodes.find(node => node.cls.endsWith('EditText') && (node.text.includes(bot.name) || node.desc.includes(bot.name))), 'pairing and selected conversation survived upgrade', { timeout: 60_000 })
      note('android-in-place-upgrade', { pairingRetained: true, selectedConversationRetained: true })
    }

    await openBotChat(host, bot)
    // The Web goal lives in the composer: "+" → Set a goal opens its form, the chip beside
    // the "+" opens its panel.
    const webPanel = host.page.locator('.bt-goal-pop')
    const webOpen = () => host.page.locator('[data-godbot-bot-goal] button.bt-goal-chip').click()
    await host.page.locator('[data-composer-card] button.bt-plus').click()
    await host.page.getByRole('menuitem', { name: /^(Set a goal|设定目标)$/u }).click()
    await webPanel.getByRole('textbox', { name: /^(Goal|目标)$/u }).fill(objective)
    await webPanel.getByRole('button', { name: /^(Start goal|开始目标)$/u }).click()
    await until(() => attempts.size === 1, 'Web start reaches the first Bot turn')
    await tap('open the same goal on Android', 'Goal', '目标')
    await ui.waitFor(nodes => ui.find(nodes, objective), 'Android reads the Web goal')
    await tap('pause from Android', 'Pause goal', '暂停目标')
    await until(async () => (await read())?.status === 'paused', 'Web host reads the Android pause')
    release()
    await until(async () => (await read())?.checkpoint?.next === 'Run the second check.', 'the paused goal saves its checkpoint')
    await host.restart()
    await openFullTeam(host)
    await openBotChat(host, bot)
    assert.equal((await read()).status, 'paused')
    assert.equal(attempts.size, 1)
    await webOpen()
    await webPanel.getByRole('button', { name: /^(Resume|继续)$/u }).click()
    const complete = await until(async () => {
      const goal = await read()
      return goal?.status === 'completed' && goal
    }, 'Web resume completes the same goal after restart')
    assert.equal(complete.turns, 2)
    assert.equal(complete.checkpoint.evidence, evidence)
    const displayed = await ui.waitFor(nodes => ui.find(nodes, evidence)
      ?? nodes.find(node => node.clickable && ['Goal', '目标'].includes(node.desc)), 'Android shows the goal again after restart', { timeout: 60_000 })
    if (displayed.text !== evidence) ui.tap(displayed)
    await ui.waitFor(nodes => ui.find(nodes, evidence), 'Android reads the finished goal evidence', { timeout: 60_000 })
    await writeFile(join(reportDir, 'android-goal-completed.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    await host.capture('web-goal-completed')
    note('paired-goal-lifecycle', { webStarted: true, appPaused: true, hostRestarted: true, webResumed: true, appReadEvidence: true, turns: complete.turns })
  } finally {
    release()
    try { if (reversed) ui.adb(['reverse', '--remove', 'tcp:' + port]) } finally { await relay.close() }
  }
}
