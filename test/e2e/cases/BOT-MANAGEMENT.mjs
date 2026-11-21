import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { until } from '../host.mjs'
import { openFullTeam, openSettingsPage, openTaskBoard } from '../native-ui.mjs'

export default async function botManagement({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  const godbot = await openFullTeam(host)
  const { page } = host
  assert.equal(await page.getByRole('button', { name: '团队管理', exact: true }).count(), 0)
  await openSettingsPage(host, /^(用量|Usage)$/u)
  await page.getByRole('button', { name: /^(用量上限与备用模型|Usage limits and fallback models)$/u }).click()
  await page.getByRole('button', { name: '保存用量策略', exact: true }).waitFor()
  const board = await openTaskBoard(host)
  await board.getByText('CI 与 Webhook', { exact: true }).waitFor()
  await board.getByText('多人共享与审计', { exact: true }).waitFor()
  assert.equal(await page.locator('input[name=teamName], input[name=memberName]').count(), 0)
  assert.equal(await page.getByRole('button', { name: '导入 Bot 团队', exact: true }).count(), 0)
  await board.getByText('分配任务', { exact: true }).click()
  const form = board.locator('form').filter({ has: page.locator('[name=criteria]') })
  const owner = form.getByLabel('负责人')
  assert.deepEqual(await owner.locator('option').evaluateAll(options => options.map(option => option.value)), [godbot])

  const worker = await host.bot('create-bot', { name: 'Board Worker', model: 'deepseek-official/deepseek-flash' })
  await owner.selectOption(worker.id)
  const name = 'Board Reviewer'
  await host.bot('update-bot', { id: worker.id, name })
  await until(async () => (await owner.locator('option:checked').textContent()) === name, 'current roster name on the task board')
  const tag = randomUUID()
  const title = 'Assignment ' + tag, nodeTitle = 'Workflow node ' + tag
  const evidence = 'Evidence returned by ' + name + ' ' + tag
  host.model.reply = () => evidence
  await form.getByLabel('任务名称').fill(title)
  await form.getByLabel('验收条件').fill('Return the verification receipt.')
  await form.getByRole('button', { name: '创建任务' }).click()
  async function reported(taskTitle) {
    const task = await until(async () => (await host.snapshot()).tasks.find(t => t.title === taskTitle && t.status === 'reported'), taskTitle + ' reported by the Bot')
    assert.equal(task.ownerId, worker.id)
    assert.equal(task.evidence, evidence)
    return task
  }
  const task = await reported(title)

  const workflows = board.getByRole('region', { name: '工作流', exact: true })
  await workflows.getByRole('button', { name: '新建工作流' }).click()
  await workflows.getByLabel('工作流名称').fill('Board flow ' + tag)
  await workflows.getByRole('button', { name: '添加节点' }).click()
  await workflows.getByLabel('节点名称').fill(nodeTitle)
  await workflows.getByLabel('负责人').selectOption(worker.id)
  await workflows.getByLabel('验收标准').fill('Reply in the same Bot conversation.')
  await workflows.getByRole('button', { name: '保存工作流' }).click()
  await workflows.getByRole('button', { name: '运行工作流' }).click()
  const node = await reported(nodeTitle)
  const state = await host.bot('state')
  const current = state.bots.find(bot => bot.id === worker.id)
  const sessionId = current.sessionId ?? current.id
  assert.ok([title, nodeTitle].every(expected => host.model.calls.some(call =>
    JSON.stringify(call.body.messages).includes(expected))), 'both assignments reached the model')
  const db = new DatabaseSync(join(host.home, 'godbot/web/godbot.sqlite3'), { readOnly: true })
  try {
    const receipt = db.prepare("SELECT data FROM records WHERE collection='botTaskDeliveries' AND id=?")
    for (const item of [task, node]) {
      const delivery = JSON.parse(receipt.get(item.assignmentId).data)
      assert.equal(delivery.botId, worker.id)
      assert.equal(delivery.sessionId, sessionId)
      assert.equal(delivery.state, 'reported')
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE collection IN ('members','teams')").get().n, 0)
  } finally {
    db.close()
  }
  await board.locator('#gb-task-' + task.id).getByRole('button', { name, exact: true }).click()
  await page.locator('.bt-head .bt-pill-name').getByText(name, { exact: true }).waitFor()
  await host.capture('bot-task-owner-conversation')
  note('workspace-bot-identities', { workspace: (await host.snapshot()).workspace.id,
    botId: worker.id, sessionId, taskId: task.id, workflowTaskId: node.id, liveName: name })
}
