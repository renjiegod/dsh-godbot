import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openFullTeam } from './native-ui.mjs'

export async function checkWorkflowTeamTemplate(host, team, saved, note) {
  const dispatch = (action, fields) => host.rpc('dispatch', { request: { action, ...fields } })
  const room = await host.bot('create-room', { name: 'Release review', members: [...new Set(saved.nodes.map(node => node.ownerId))] })
  await openFullTeam(host)
  await host.page.getByRole('button', { name: '工作台收件箱' }).click()
  const dialog = host.page.getByRole('dialog', { name: '工作台收件箱' })
  await dialog.getByText('团队模板', { exact: true }).click()
  await dialog.getByLabel('导出范围').selectOption(room.id)
  const download = host.page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出模板' }).click()
  const path = join(host.root, 'team-with-graphs.json')
  await (await download).saveAs(path)
  const text = await readFile(path, 'utf8')
  const file = JSON.parse(text)
  assert.equal(file.workflows.length, 2)
  for (const flow of file.workflows) {
    assert.deepEqual(flow.edges, saved.edges)
    assert.ok(flow.nodes.every(n => file.bots.some(b => b.ref === n.ownerId)))
  }
  for (const id of [team.id, saved.id, ...saved.nodes.map(n => n.ownerId)]) assert.ok(!text.includes(id))
  await dialog.getByLabel('导入团队模板').setInputFiles(path)
  await dialog.getByRole('region', { name: '团队模板预览' }).getByText('工作流 · ' + saved.name, { exact: false }).first().waitFor()
  const priorRooms = new Set((await host.bot('state')).rooms.map(room => room.id))
  await dialog.getByRole('button', { name: '确认导入模板' }).click()
  await dialog.getByText(/^已创建 /).waitFor()
  const newRooms = (await host.bot('state')).rooms.filter(room => !priorRooms.has(room.id))
  assert.equal(newRooms.length, 1)
  const second = await dispatch('team-workspace.templateExport', { roomId: newRooms[0].id })
  assert.deepEqual(second.workflows, file.workflows)
  const board = await dispatch('workflow.list', { teamId: team.id })
  assert.equal(board.runs.length, 2)
  assert.equal(board.workflows.filter(flow => flow.nodes.every(node => newRooms[0].members.includes(node.ownerId))).length, 2)
  note('portable-team-workflows', { graphs: file.workflows.length, rooms: file.rooms.length, members: file.bots.length })
}
