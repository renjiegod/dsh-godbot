import assert from 'node:assert/strict'
import { fullTeamRoutines } from '../full-team-routines.mjs'
import { until } from '../host.mjs'
import { openFullTeam, openSettingsPage } from '../native-ui.mjs'

export default async function E14({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await fullTeamRoutines(host, note)

  const { page } = host
  const worker = await host.bot('create-bot', { name: '计划执行 Bot', model: 'deepseek-official/deepseek-flash' })
  const openRoutines = () => openSettingsPage(host, /^(定时派工|Scheduled assignments)$/u)
  await openRoutines()
  const pageRegion = page.getByRole('region', { name: '团队自动化任务' })
  await pageRegion.getByRole('button', { name: '新建自动化任务' }).click()
  const form = page.getByRole('form', { name: '自动化任务设置' })
  const title = '核对构建结果'
  const criteria = '列出本轮构建编号并提交验收'
  await form.getByLabel('任务名称').fill(title)
  await form.getByLabel('负责人').selectOption(worker.id)
  await form.getByLabel('执行要求与验收条件').fill(criteria)
  await form.getByLabel('执行频率').selectOption('weekly')
  await form.getByLabel('周五').check()
  await form.getByLabel('时区').fill('Asia/Taipei')
  await form.getByRole('button', { name: '保存任务' }).click()
  const card = pageRegion.getByRole('article', { name: title })
  await card.getByText('周一、五 09:00 · Asia/Taipei', { exact: true }).waitFor()
  await card.getByRole('button', { name: '暂停', exact: true }).click()
  await card.getByText('已暂停', { exact: true }).waitFor()
  const { workspace } = await host.snapshot()
  const call = (name, args) => host.rpc('dispatch', { request: { action: 'automation.routine.' + name, teamId: workspace.id, ...args } })
  const [plan] = (await call('list')).routines
  assert.equal(plan.ownerId, worker.id)
  assert.deepEqual(plan.schedule.weekdays, [1, 5])
  await host.restart()
  await openFullTeam(host)
  await openRoutines()
  await card.getByText('已暂停', { exact: true }).waitFor()
  await card.getByRole('button', { name: '立即运行' }).click()
  await card.getByText('手动运行', { exact: true }).waitFor()
  const manual = (await call('history', { id: plan.id })).items[0]
  assert.ok(manual.runId && manual.rootTaskId)
  await card.getByRole('button', { name: '查看任务' }).click()
  await page.locator('[id="gb-task-' + manual.rootTaskId + '"]').getByRole('heading', { name: title }).waitFor()
  await until(() => host.model.calls.some(c => JSON.stringify(c.body.messages).includes(criteria)), 'scheduled Bot assignment reaching fixture model')
  await openRoutines()
  await card.getByRole('button', { name: '恢复', exact: true }).click()
  await card.getByText('已启用', { exact: true }).waitFor()
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await form.getByLabel('执行频率').selectOption('once')
  const future = await page.evaluate(() => {
    const date = new Date(Date.now() + 7_000)
    return new Date(date.getTime() - 60_000 * date.getTimezoneOffset()).toISOString().slice(0, 19)
  })
  await form.getByLabel('执行时间', { exact: false }).fill(future)
  await form.getByRole('button', { name: '保存任务' }).click()
  const automatic = await until(async () => (await call('history', { id: plan.id })).items.find(i => i.trigger === 'scheduled'), 'one-time clock firing')
  assert.ok(automatic.rootTaskId)
  assert.notEqual(automatic.runId, manual.runId)
  await card.getByText('已结束', { exact: true }).waitFor()
  await card.getByRole('button', { name: '运行记录' }).click()
  await card.getByText('定时派工', { exact: true }).waitFor()
  await host.capture('bot-task-routine-history')
  await card.getByRole('button', { name: '删除', exact: true }).click()
  await card.getByRole('button', { name: '确认删除', exact: true }).click()
  await pageRegion.getByText('还没有定时派工的任务。').waitFor()
  const tasks = (await host.snapshot()).tasks.filter(t => t.ownerId === worker.id && t.title === title)
  assert.equal(tasks.length, 2)
  note('bot-routine-manual-and-scheduled', { botId: worker.id, planId: plan.id, manual: manual.runId, scheduled: automatic.runId, remainingTasks: tasks.length })
}
