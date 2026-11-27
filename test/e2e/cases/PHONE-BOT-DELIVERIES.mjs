import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { startRelay } from '../phone-relay.mjs'
import { channel } from './WORK-BOARD.mjs'

export default async function phoneBotDeliveries({ makeHost, candidate, reportDir, scratch, note }) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('Set GODBOT_ANDROID_E2E to the Android checkout')
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1') throw new EnvironmentError('Select a disposable Android emulator')
  const relay = await startRelay(scratch, note)
  const port = new URL(relay.url).port
  const tap = async (why, ...names) => ui.tap(await ui.waitFor(nodes => ui.find(nodes, ...names), why, { timeout: 60_000 }))
  const gate = Promise.withResolvers()
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    await openFullTeam(host)

    const makeBot = name => host.bot('create-bot', { name, model: 'deepseek-official/deepseek-flash' })
    const recipient = await makeBot('Delivery Recipient')
    const sender = await makeBot('Delivery Sender')
    const roster = () => host.bot('state')
    async function ready(bot) {
      return until(async () => {
        const chat = await host.bot('chat', { botId: bot.id })
        if (chat.items.some(item => item.kind === 'bot') && !(await roster()).partsRunning?.[chat.sessionId]) return chat.sessionId
      }, 'the delivery fixture Bot is ready')
    }
    const [to, from] = await Promise.all([ready(recipient), ready(sender)])
    const message = 'Verify the warehouse delivery from the phone fixture'
    const busy = 'Hold the recipient turn for the paired client check'
    const sendPrompt = 'Dispatch the paired delivery check'
    let sent = false
    host.model.reply = async body => {
      const input = JSON.stringify(body.messages?.findLast(row => row.role === 'user')?.content ?? '')
      if (input.includes(sendPrompt) && !sent) {
        sent = true
        return [{ type: 'tool_use', name: 'message_bot', input: {
          to: recipient.name, conversation: to, when: 'queue', message,
        } }]
      }
      if (input.includes(busy)) await gate.promise
      if (input.includes('[Message from') && input.includes(message)) return 'The fixture delivery was received and processed.'
      return 'Fixture acknowledged.'
    }

    await channel(host, 'phone-set', { server: relay.url, on: true })
    await until(async () => (await channel(host, 'phone-set')).status === 'online', 'the paired test relay is online')
    const { pairing } = await channel(host, 'phone-pair')
    const apk = process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk')
    ui.install(apk)
    ui.shell('pm clear ' + ui.PACKAGE)
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    ui.openUrl(pairing.uri)
    await tap('confirm the isolated pairing', 'Pair', '配对')
    await ui.waitFor(nodes => nodes.some(node => node.cls.endsWith('EditText')), 'the paired Android chat', { timeout: 60_000 })
    await tap('show the team list', 'Open team list', '打开团队列表')
    await tap('open the receiving Bot', recipient.name, /^Delivery Recipient,/u)
    await tap('open the delivery panel', 'Bot message delivery', 'Bot 消息投递')
    await ui.waitFor(nodes => ui.find(nodes, 'No messages yet', '还没有消息', '暂无消息'), 'the delivery panel loads')

    await host.bot('send', { sessionId: to, text: busy })
    await until(() => host.model.calls.some(call => JSON.stringify(call.body.messages).includes(busy)), 'the recipient has an active model call')
    await host.bot('send', { sessionId: from, text: sendPrompt })
    const view = () => host.bot('bot-deliveries', { botId: recipient.id, sessionId: to })
    const row = await until(async () => (await view()).find(item => item.text === message && item.state === 'queued'), 'the host queued the message')
    await ui.waitFor(nodes => ui.find(nodes, message) && ui.find(nodes, 'Queued', '已入队'), 'Android reads the queued state')
    await writeFile(join(reportDir, 'android-queued.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    await openBotChat(host, sender)
    await host.page.locator('.bt-event').filter({ hasText: recipient.name }).last().click()
    const webRow = host.page.locator('.bt-exchange .bt-group-msg').filter({ hasText: message })
    await webRow.locator('[data-delivery-state="queued"]').waitFor()
    await host.capture('web-queued')

    gate.resolve()
    await until(async () => (await view()).find(item => item.id === row.id)?.state === 'replied', 'the host recorded a reply for the same message')
    await webRow.locator('[data-delivery-state="replied"]').waitFor()
    await ui.waitFor(nodes => ui.find(nodes, message) && ui.find(nodes, 'Replied', '已回复'), 'the open Android panel refreshed to the replied state')
    await writeFile(join(reportDir, 'android-replied.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    await host.capture('web-replied')
    note('paired-delivery-status', { messageId: row.id, recipient: recipient.id, states: ['queued', 'replied'] })
  } finally {
    gate.resolve()
    try { ui.adb(['reverse', '--remove', 'tcp:' + port]) } catch {}
    await relay.close()
  }
}
