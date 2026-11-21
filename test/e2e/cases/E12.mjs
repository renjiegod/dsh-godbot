import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { until } from '../host.mjs'

// Upgrade an actual two-roster profile. Only the independent team's data
// should disappear; the Bot must keep its own DSH conversation and settings.
export default async function E12({ makeHost, previous, candidate, note }) {
  const host = await makeHost()
  await host.install(previous)
  await host.start()
  const req = (action, fields = {}) => host.rpc('godbot/dispatch', { request: { action, requestId: randomUUID(), ...fields } })
  const team = await req('team.create', { name: 'Retired team', cwd: host.workspace })
  const member = await req('member.add', { teamId: team.id, name: 'Independent worker', kind: 'dsh' })
  const oldTask = await req('task.create', { teamId: team.id, ownerId: member.id, title: 'Old board task', criteria: 'Report a receipt' })
  await until(async () => !(await host.snapshot()).members.some(row => row.activeTurnId), 'old worker is idle')
  const bot = await host.bot('create-bot', { name: 'Retained Bot', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'original Bot greeting')
  const previousChat = await host.bot('chat', { botId: bot.id })
  await host.stop()
  await host.install(candidate)
  await host.start()
  const upgraded = await host.snapshot()
  assert.deepEqual(upgraded.tasks, [])
  assert.ok(upgraded.bots.some(item => item.id === bot.id && item.sessionId === previousChat.sessionId))
  assert.ok(!JSON.stringify(upgraded).includes(member.id))
  const chat = await host.bot('chat', { botId: bot.id })
  assert.equal(chat.sessionId, previousChat.sessionId)
  assert.deepEqual(chat.items, previousChat.items)
  await assert.rejects(req('team.create', { name: 'Retired team', cwd: host.workspace }))
  await assert.rejects(req('member.send', { memberId: member.id, text: 'No longer a target' }))
  await assert.rejects(req('task.create', { ownerId: member.id, title: 'Old worker', criteria: 'Unavailable' }))
  const live = await req('task.create', { ownerId: bot.id, title: 'New board task', criteria: 'Confirm receipt' })
  await until(async () => (await host.snapshot()).tasks.find(row => row.id === live.id)?.status === 'reported', 'new Bot reported')
  await host.restart()
  const final = await host.snapshot()
  assert.deepEqual(final.tasks.map(row => [row.id, row.ownerId]), [[live.id, bot.id]])
  note('single-roster-cutover', { oldMemberDiscarded: member.id, oldTaskDiscarded: oldTask.id, botId: bot.id,
    retainedSessionId: chat.sessionId, retainedBotTaskId: live.id })
}
