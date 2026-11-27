import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { dshForPreviousArchive, until } from '../host.mjs'

// Update a profile from the last public release (--previous; the release tool
// passes the newest published archive) to the candidate. What the user made on
// the old release must all be there afterwards: the Bot with its conversation and
// a finished board task. The updated Host then takes new work and keeps
// everything across a restart.
export default async function UPGRADE_PREVIOUS({ makeHost, previous, candidate, scratch, note }) {
  const host = await makeHost()
  await host.install(previous, await dshForPreviousArchive(previous, scratch))
  await host.start()
  const req = (action, fields = {}) => host.rpc('godbot/dispatch', { request: { action, requestId: randomUUID(), ...fields } })
  const reported = id => until(async () => (await host.snapshot()).tasks.find(row => row.id === id)?.status === 'reported', 'task ' + id + ' reported', 60_000)

  const bot = await host.bot('create-bot', { name: 'Updated Bot', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'Bot greeting on ' + previous.version)
  const before = await req('task.create', { ownerId: bot.id, title: 'Task before the update', criteria: 'Confirm receipt' })
  await reported(before.id)
  // The conversation is compared item by item after the update, so take it once
  // nothing is still being written to it.
  const settled = async () => {
    const first = await host.bot('chat', { botId: bot.id })
    await delay(1500)
    const second = await host.bot('chat', { botId: bot.id })
    return JSON.stringify(first) === JSON.stringify(second) && second
  }
  const previousChat = await until(settled, 'the Bot conversation to settle on ' + previous.version, 60_000)
  const previousTasks = (await host.snapshot()).tasks.map(row => [row.id, row.ownerId, row.status])
  await host.stop()

  await host.install(candidate)
  await host.start()
  const updated = await host.snapshot()
  assert.ok(updated.bots.some(item => item.id === bot.id && item.sessionId === previousChat.sessionId), 'the Bot keeps its conversation')
  assert.deepEqual(updated.tasks.map(row => [row.id, row.ownerId, row.status]), previousTasks)
  const chat = await host.bot('chat', { botId: bot.id })
  assert.equal(chat.sessionId, previousChat.sessionId)
  assert.deepEqual(chat.items, previousChat.items)

  const after = await req('task.create', { ownerId: bot.id, title: 'Task after the update', criteria: 'Confirm receipt' })
  await reported(after.id)
  await host.restart()
  const final = await host.snapshot()
  assert.deepEqual(final.tasks.map(row => row.id).sort(), [before.id, after.id].sort())
  assert.ok(final.bots.some(item => item.id === bot.id && item.sessionId === previousChat.sessionId))
  note('updated-from-previous', { from: previous.version, fromBuild: previous.buildId, to: candidate.version, toBuild: candidate.buildId,
    botId: bot.id, sessionId: chat.sessionId, chatItems: chat.items.length, tasks: [before.id, after.id] })
}
