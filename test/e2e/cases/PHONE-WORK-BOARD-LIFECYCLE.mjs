import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { withAndroidBotChat } from '../android-chat.mjs'
import { EnvironmentError, until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { channel } from './WORK-BOARD.mjs'

export default async function check(context) {
  if (!process.env.GODBOT_ANDROID_E2E || !process.env.GODBOT_E2E_APK)
    throw new EnvironmentError('Select a test Android checkout and APK.')
  const host = await context.makeHost()
  await host.install(context.candidate)
  await host.start()
  await openFullTeam(host)
  const bot = await host.bot('create-bot', { name: 'Lifecycle Mobile', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'Bot is ready')
  await openBotChat(host, bot)
  const prompt = 'Compare the two sample receipts'
  host.model.reply = body => JSON.stringify(body.messages).includes('Verify the second sample')
    ? 'Revised result: both sample receipts match.'
    : 'First result: the first sample receipt matches.'
  const read = id => channel(host, 'board-item', { id })
  await withAndroidBotChat(context, host, bot, async ui => {
    const tap = async (reason, ...labels) => ui.tap(await ui.waitFor(nodes => ui.find(nodes, ...labels), reason))
    const composer = await ui.waitFor(nodes => nodes.find(node => node.cls.endsWith('EditText')), 'Android composer')
    ui.tap(composer)
    ui.typeText(prompt)
    await tap('send the work from Android', 'Send', '发送')
    const first = await until(async () => {
      const { items } = await host.bot('chat', { botId: bot.id })
      const user = items.find(item => item.kind === 'user' && item.text === prompt)
      if (!user?.workItemId) return undefined
      const card = await read(user.workItemId)
      return card.lifecycleState === 'review' && card
    }, 'the phone request produced review evidence')
    await host.page.locator('.bt-umsg').filter({ hasText: prompt }).getByRole('button', { name: new RegExp(first.id) }).click()
    await tap('open the linked card from Android chat', new RegExp('Open work item ' + first.id + '|打开工作项 ' + first.id + '|^' + first.id + '$'))
    await ui.waitFor(nodes => ui.find(nodes, /First result: the first sample receipt matches/), 'first Android evidence')
    const detail = host.page.locator('.wb-detail')
    await detail.getByRole('button', { name: /Request changes|退回修改/ }).click()
    await host.page.locator('.wb-editor textarea').fill('Verify the second sample')
    await host.page.locator('.wb-editor button[type=submit]').click()
    const updated = await until(async () => {
      const card = await read(first.id)
      return card.lifecycleState === 'review' && card.evidenceRevision === 2 && card
    }, 'Web rework produced the next attempt')
    assert.equal(updated.execution.sessionId, first.execution.sessionId)
    await ui.waitFor(nodes => ui.find(nodes, /Revised result: both sample receipts match/), 'Android receives the new evidence')
    await tap('review the current Android evidence', 'Accept evidence', '验收通过')
    await tap('confirm Android acceptance', 'Confirm', '确认')
    await until(async () => (await read(first.id)).lifecycleState === 'done', 'Android acceptance is visible to Web')
    await detail.getByText(/Accepted|已验收/).first().waitFor()
    await writeFile(join(context.reportDir, 'android-lifecycle-accepted.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    context.note('android-work-lifecycle', { id: first.id, attempt: updated.attempt, evidenceRevision: 2 })
  })
}
