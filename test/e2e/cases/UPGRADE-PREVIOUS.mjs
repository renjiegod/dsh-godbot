import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { dshForPreviousArchive, until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { channel } from './WORK-BOARD.mjs'

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
  const [major, minor, patch] = previous.version.split('.').map(part => Number.parseInt(part, 10))
  const legacyDiscussion = major > 0 || minor > 2 || minor === 2 && patch >= 36
  const legacyFile = text => ({ name: 'upgrade-proof.txt', mime: 'text/plain', data: Buffer.from(text).toString('base64') })
  let discussion
  if (legacyDiscussion) {
    await openFullTeam(host)
    const draft = await channel(host, 'board-action', { op: 'create', title: 'Before upgrade', requestId: 'upgrade-draft' })
    const first = await channel(host, 'board-comment', {
      id: draft.id, op: 'post', body: 'Original upgrade proof', quiet: true,
      files: [legacyFile('Version one')], requestId: 'upgrade-comment-before',
    })
    discussion = { id: draft.id, commentId: first.commentId }
  }
  await host.stop()

  await host.install(candidate)
  await host.start()
  const updated = await host.snapshot()
  assert.ok(updated.bots.some(item => item.id === bot.id && item.sessionId === previousChat.sessionId), 'the Bot keeps its conversation')
  assert.deepEqual(updated.tasks.map(row => [row.id, row.ownerId, row.status]), previousTasks)
  const chat = await host.bot('chat', { botId: bot.id })
  assert.equal(chat.sessionId, previousChat.sessionId)
  assert.deepEqual(chat.items, previousChat.items)
  if (discussion) {
    await openFullTeam(host)
    const artifacts = () => channel(host, 'board-artifacts', { id: discussion.id })
    const [before] = (await artifacts()).artifacts
    assert.equal(before.versions[0].version, 1)
    const bytes = await channel(host, 'board-comment-file', {
      ...discussion, fileId: before.versions[0].id,
    })
    assert.equal(Buffer.from(bytes.bytes, 'base64').toString(), 'Version one')
    await channel(host, 'board-comment', {
      id: discussion.id, parentId: discussion.commentId, op: 'post', body: 'Updated upgrade proof', quiet: true,
      files: [legacyFile('Version two')], requestId: 'upgrade-comment-after',
    })
    assert.deepEqual((await artifacts()).artifacts[0].versions.map(file => file.version), [1, 2])
    note('updated-board-discussion', { id: discussion.id, versions: [1, 2], originalBytesMatched: true })
  }

  const after = await req('task.create', { ownerId: bot.id, title: 'Task after the update', criteria: 'Confirm receipt' })
  await reported(after.id)
  await host.restart()
  const final = await host.snapshot()
  assert.deepEqual(final.tasks.map(row => row.id).sort(), [before.id, after.id].sort())
  assert.ok(final.bots.some(item => item.id === bot.id && item.sessionId === previousChat.sessionId))
  note('updated-from-previous', { from: previous.version, fromBuild: previous.buildId, to: candidate.version, toBuild: candidate.buildId,
    botId: bot.id, sessionId: chat.sessionId, chatItems: chat.items.length, tasks: [before.id, after.id] })
}
