import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from './host.mjs'
import { installLiveCli } from './live-cli.mjs'
import { openFullTeam } from './native-ui.mjs'

export default async function liveTeamRoutines({ makeHost, candidate, note }) {
  const host = await makeHost()
  const { page } = host
  // A title or memory observer may still contact the isolated DSH provider.
  // No Messages request to it can supply a model response in this scenario.
  host.model.reply = () => ({ failure: { status: 400, message: 'This validation uses the signed-in native CLI backends.' } })
  const participants = [
    { engine: 'claude', name: 'Sum', route: 'local-claude-code', operation: 'add the two numbers' },
    { engine: 'codex', name: 'Product', route: 'local-codex-cli', operation: 'multiply the two numbers' },
  ]
  for (const member of participants) {
    const { version } = await installLiveCli(host, member.engine)
    member.version = version
  }
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  for (const member of participants) {
    const bot = await host.bot('create-bot', {
      name: member.name, model: member.route + '/default', workDir: host.workspace,
      role: 'In the local arithmetic test, ' + member.operation + '.',
    })
    member.botId = bot.id
  }

  const marker = randomUUID()
  const a = randomInt(13, 48), b = randomInt(3, 10)
  const title = '双 Agent 群聊核对 ' + marker.slice(0, 8)
  const prompt = 'Arithmetic check ' + marker + '. The two numbers are ' + a + ' and ' + b +
    '. Each member should post its own one-line answer into this group. Sum adds, Product multiplies.' +
    ' Reply exactly with the check ID, your member name, and your decimal answer, separated by spaces.' +
    ' Only do your assigned mental arithmetic. No shell, files, browsing, delegation or mentions.'
  const room = await host.bot('create-room', { name: '实时双 Agent 核对', members: participants.map(p => p.botId) })
  await host.bot('update-room', { id: room.id, mode: 'everyone', permission: 'read-only', workDir: host.workspace })
  note('live-group-roster', { roomId: room.id, participants, mode: 'everyone', permission: 'read-only' })
  const shortcut = page.locator('.bt-side').getByRole('button', { name: /^(会话定时消息|Scheduled messages)$/u })
  await shortcut.click()
  const view = page.getByRole('region', { name: /^(会话定时消息|Scheduled messages)$/u })
  await view.getByRole('button', { name: '新建任务' }).click()
  const form = view.getByRole('form', { name: '新建自动化任务' })
  await form.getByLabel('执行会话').selectOption(room.id)
  await form.getByLabel('任务名称').fill(title)
  await form.getByLabel('任务指令').fill(prompt)
  await form.getByLabel('重复方式').selectOption('at')
  const local = await page.evaluate(() => {
    const date = new Date(Math.ceil((Date.now() + 6000) / 60000) * 60000)
    return { field: new Date(date.getTime() - 60000 * date.getTimezoneOffset()).toISOString().slice(0, 16), iso: date.toISOString() }
  })
  await form.getByLabel(/执行时间/u).fill(local.field)
  await form.getByRole('button', { name: '创建任务' }).click()
  const card = view.getByRole('article', { name: title })
  await card.waitFor()
  const getTask = async () => (await host.bot('schedules')).tasks.find(t => t.title === title)
  const task = await getTask()
  assert.equal(task.roomId, room.id)
  assert.equal(task.scheduledAt, local.iso)
  note('created-via-left-sidebar', { taskId: task.id, target: task.roomId, sessionId: task.sessionId, dueAt: task.scheduledAt, marker, numbers: [a, b] })
  await host.capture('scheduled-group')
  const latestRoom = () => host.bot('room-chat', { roomId: room.id })
  const replies = []
  try {
    await until(async () => (await getTask()).status === 'ended', 'actual scheduled clock firing', 85_000)
    for (const member of participants) {
      const answer = member.engine === 'claude' ? a + b : a * b
      const expected = [marker, member.name, answer].join(' ')
      const post = await until(async () => (await latestRoom()).items.find(item =>
        item.botId === member.botId && (item.text ?? '').includes(expected)), member.engine + ' posts its computed answer in the group', 150_000)
      replies.push({ engine: member.engine, botId: post.botId, text: post.text, postId: post.id, expected })
      note('real-member-room-reply', replies.at(-1))
    }
    const state = JSON.parse(await readFile(join(host.home, 'godbot/web/team-workspace/state.json'), 'utf8'))
    const bindings = participants.map(member => {
      const sessionId = state.rooms[room.id].sessions[member.botId]
      const binding = state.localAgents.sessions[sessionId]
      assert.equal(binding.route, member.route)
      assert.ok(binding.cliSessionId)
      return { engine: member.engine, version: member.version, sessionId, nativeSessionId: binding.cliSessionId }
    })
    assert.notEqual(bindings[0].nativeSessionId, bindings[1].nativeSessionId)
    note('distinct-native-cli-sessions', { bindings })
    const refused = host.model.calls.filter(call => JSON.stringify(call.body.messages).includes(marker)).map(call => ({
      id: call.id, sessionId: call.sessionId, tools: call.body.tools?.slice(0, 4).map(t => t.name),
      systemPrefix: (typeof call.body.system === 'string' ? call.body.system : call.body.system?.[0]?.text)?.slice(0, 200),
      messagePrefix: JSON.stringify(call.body.messages[0]?.content)?.slice(0, 150),
    }))
    const history = () => host.rpc('dispatch', { request: { action: 'team-workspace.scheduleHistory', id: task.id, sessionId: task.sessionId } })
    const { records } = await history()
    assert.equal(records.length, 1)
    const [receipt] = records
    assert.equal(receipt.prompt, prompt)
    assert.equal(receipt.targetSessionId, task.sessionId)
    assert.ok(Date.parse(receipt.deliveredAt) >= Date.parse(local.iso))
    await card.getByRole('button', { name: '投递记录' }).click()
    const historyPanel = card.getByRole('region', { name: '投递记录' })
    await historyPanel.getByText(prompt, { exact: true }).waitFor()
    await historyPanel.getByRole('button', { name: '打开会话' }).click()
    for (const reply of replies) await page.getByText(reply.expected, { exact: false }).first().waitFor()
    await host.capture('two-real-member-replies')
    await host.restart()
    await openFullTeam(host)
    const restored = await history()
    assert.deepEqual(restored.records, records)
    assert.equal((await getTask()).status, 'ended')
    const chat = await latestRoom()
    for (const reply of replies) {
      assert.equal(chat.items.filter(item => item.botId === reply.botId && item.text?.includes(reply.expected)).length, 1)
    }
    note('persisted-group-delivery', { taskId: task.id, marker, messageId: receipt.messageId,
      dueAt: local.iso, deliveredAt: receipt.deliveredAt, refusedFixtureCallsWithMarker: refused,
      successfulFixtureGenerations: 0, receiptsAfterRestart: restored.records.length })
  } catch (error) {
    const { items } = await latestRoom()
    const state = await host.bot('state')
    note('live-group-diagnostic', {
      taskStatus: (await getTask())?.status,
      lastPosts: items.slice(-6).map(row => ({ kind: row.kind, botId: row.botId, text: row.text?.slice(-300) })),
      approvals: state.work.approvals.filter(row => row.answerable).map(row => ({ tool: row.tool, botId: row.botId })),
    })
    throw error
  }
}
