import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { until } from './host.mjs'
import { openFullTeam } from './native-ui.mjs'

export async function fullTeamRoutines(host, note) {
  const { page } = host
  const marker = randomUUID()
  const title = '自动化验收 ' + marker
  const prompt = '请核对工作日历 ' + marker
  const revised = prompt + ' 并按时区汇总'
  const reply = '日历已核对 ' + marker
  const oldReply = host.model.reply
  host.model.reply = (body, call) => JSON.stringify(body.messages).includes(revised) ? reply : oldReply(body, call)
  try {
    const bot = await host.bot('create-bot', { name: '自动化验收 Bot', model: 'deepseek-official/deepseek-flash' })
    const shortcut = page.locator('.bt-side').getByRole('button', { name: /^(会话定时消息|Scheduled messages)$/u })
    const open = async () => {
      await openFullTeam(host)
      await shortcut.click()
    }
    const view = page.getByRole('region', { name: /^(会话定时消息|Scheduled messages)$/u })
    const card = view.getByRole('article', { name: title, exact: true })
    const stored = async () => (await host.bot('schedules')).tasks.find(t => t.title === title)
    await openFullTeam(host)
    const grip = page.locator('.bt-leftcol-grip')
    const resize = async width => {
      const box = await grip.boundingBox()
      assert.ok(box, 'left sidebar resize grip is visible')
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + box.width / 2, y)
      await page.mouse.down()
      await page.mouse.move(width, y, { steps: 12 })
      await page.mouse.up()
    }
    await shortcut.locator('svg').waitFor()
    assert.equal((await shortcut.innerText()).trim(), '')
    await host.capture('full-team-automation-sidebar')
    await resize(80)
    const rail = page.locator('.bt-side.bt-rail').getByRole('button', { name: /^(会话定时消息|Scheduled messages)$/u })
    await rail.locator('svg').waitFor()
    assert.equal((await rail.innerText()).trim(), '')
    await rail.click()
    await view.getByRole('button', { name: '新建任务' }).waitFor()
    await page.keyboard.press('Escape')
    await view.waitFor({ state: 'detached' })
    await resize(300)
    await page.locator('.bt-side:not(.bt-rail)').getByRole('button', { name: /^(会话定时消息|Scheduled messages)$/u }).click()
    await view.getByRole('button', { name: '新建任务' }).click()
    let form = view.getByRole('form', { name: '新建自动化任务' })
    await form.getByLabel('执行会话').selectOption(bot.id)
    await form.getByLabel('任务名称').fill(title)
    await form.getByLabel('任务指令').fill(prompt)
    await form.getByLabel('重复方式').selectOption('cron')
    // Pick a month different from the current one so a real timer cannot race the manual test.
    const month = (new Date().getUTCMonth() + 6) % 12 + 1
    const expression = '15 9 1 ' + month + ' *'
    await form.getByLabel(/Cron 表达式/u).fill(expression)
    await form.getByLabel('时区').fill('Asia/Taipei')
    await form.getByRole('button', { name: '创建任务' }).click()
    await card.waitFor()
    const created = await stored()
    assert.equal(created.botId, bot.id)
    assert.equal(created.expression, expression)
    assert.equal(created.timeZone, 'Asia/Taipei')

    await card.getByRole('button', { name: '暂停' }).click()
    await card.getByText('已暂停', { exact: true }).waitFor()
    await card.getByRole('button', { name: '编辑' }).click()
    form = view.getByRole('form', { name: '编辑自动化任务' })
    await form.getByLabel('任务指令').fill(revised)
    await form.getByRole('button', { name: '保存修改' }).click()
    await card.getByText(revised, { exact: true }).waitFor()
    await host.restart()
    await open()
    await card.getByText('已暂停', { exact: true }).waitFor()
    const restored = await stored()
    assert.equal(restored.id, created.id)
    assert.equal(restored.scheduledAt, created.scheduledAt)
    assert.equal(restored.prompt, revised)

    await card.getByRole('button', { name: '立即运行' }).click()
    await view.getByText('已投递到会话', { exact: true }).waitFor()
    await card.getByRole('button', { name: '投递记录' }).click()
    const history = card.getByRole('region', { name: '投递记录' })
    await history.getByText(revised, { exact: true }).waitFor()
    const delivered = await stored()
    assert.equal(delivered.status, 'paused')
    assert.equal(delivered.scheduledAt, created.scheduledAt)
    assert.ok(delivered.lastDelivery?.messageId)
    await until(() => host.model.calls.find(call => JSON.stringify(call.body.messages).includes(revised)), 'scheduler prompt at fixture model')
    await host.capture('full-team-automation-history')
    await history.getByRole('button', { name: '打开会话' }).click()
    await page.getByText(reply, { exact: true }).first().waitFor()

    await shortcut.click()
    await card.getByRole('button', { name: '恢复' }).click()
    await card.getByRole('button', { name: '暂停' }).waitFor()
    await card.getByRole('button', { name: '删除' }).click()
    await card.getByRole('button', { name: '确认删除' }).click()
    await card.waitFor({ state: 'detached' })
    assert.equal(await stored(), undefined)
    note('full-team-automation', { taskId: created.id, botId: bot.id, expression, timeZone: created.timeZone,
      messageId: delivered.lastDelivery.messageId, scheduledAt: created.scheduledAt, openedReply: true })
  } finally {
    host.model.reply = oldReply
  }
}
