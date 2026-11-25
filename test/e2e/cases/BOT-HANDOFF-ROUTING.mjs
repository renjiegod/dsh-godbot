import assert from 'node:assert/strict'
import { until } from '../host.mjs'

export default async function botHandoffRouting({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()

  const implementation = '实现备用 Agent 切换和分组记忆。请交给发布机器人发布，并在公开后继续验证。'
  const handoff = '两项改动已经验收。请发布 Web 和 Android，并直接向用户汇报。'
  const progress = '签名校验已通过，请保留测试设备。'
  const complete = '两个制品已公开，可以用正式包复验。'
  const late = '升级清单也已同步。'
  const other = '统计周五午餐的报名人数。'
  const next = '还有一项来自不同会话的工作。请做本周报表。'
  const handoff2 = '请发送本周报表，再通知我安排复查。'
  const complete2 = '结果已交付，请进行抽查。'
  const unrelated = '请帮忙整理明年的休假安排。'
  const engineerName = 'Implementation Bot'
  const publisherName = 'Release Bot'
  const archiveOrigin = Promise.withResolvers()
  let sentProgress = false
  let sentComplete = false
  const tool = (to, message, extra = {}) => [{ type: 'tool_use', name: 'message_bot', input: { to, message, reply_to: 'user', ...extra } }]
  const report = update => '收到发布机器人的消息。' + update
  host.model.reply = async body => {
    const last = JSON.stringify(body.messages?.findLast(message => message.role === 'user')?.content ?? '')
    const toolResult = last.includes('tool_result')
    if (!toolResult && last.includes(implementation)) return tool(publisherName, handoff)
    if (!toolResult && last.includes(next)) return tool(publisherName, handoff2)
    if (!toolResult && last.includes(handoff2)) return tool(engineerName, complete2)
    if (!toolResult && last.includes(handoff) && !sentProgress) {
      await archiveOrigin.promise
      sentProgress = true
      return tool(engineerName, progress)
    }
    if (toolResult && sentProgress && !sentComplete && JSON.stringify(body.messages).includes(handoff)) {
      sentComplete = true
      return tool(engineerName, complete, { when: 'queue' })
    }
    if (!toolResult && last.includes('Forward the late release update')) return tool(engineerName, late)
    if (!toolResult && last.includes('Assign a separate task')) return tool(engineerName, unrelated, { new_conversation: true })
    const update = [progress, complete, late, complete2].find(text => last.includes('[Message from') && last.includes(text))
    if (update !== undefined) return report(update)
    return 'Fixture acknowledged.'
  }

  const create = name => host.bot('create-bot', { name, model: 'deepseek-official/deepseek-flash' })
  const engineer = await create(engineerName)
  const publisher = await create(publisherName)
  const roster = () => host.bot('state')
  const bot = async id => (await roster()).bots.find(value => value.id === id)
  const idle = id => until(async () => (await roster()).partsRunning?.[id] !== true, 'turn finished in ' + id)
  const send = (sessionId, text) => host.bot('send', { sessionId, text })
  const calls = (body, header = '') => until(() => host.model.calls.find(call => {
    const last = JSON.stringify(call.body.messages?.findLast(message => message.role === 'user')?.content ?? '')
    return last.includes(body) && last.includes(header)
  }), 'model received ' + body, 15_000)
  const newPart = async id => {
    const before = (await bot(id)).sessionId
    assert.equal(await host.bot('bot-new-part', { botId: id }), true)
    return until(async () => {
      const value = await bot(id)
      return value.sessionId !== before && value.parts.includes(before) && value.sessionId
    }, 'archived ' + before)
  }
  for (const id of [engineer.id, publisher.id]) {
    await until(async () => (await host.bot('chat', { botId: id })).items.some(item => item.kind === 'bot'), 'setup greeting')
    await idle(id)
  }
  const origin = (await bot(engineer.id)).sessionId
  const publisherForeground = (await bot(publisher.id)).sessionId
  await send(publisherForeground, 'Review the February coffee machine maintenance calendar')
  await calls('February coffee machine')
  await idle(publisherForeground)
  await send(origin, implementation)
  const publishing = await calls(handoff, '[Message from')
  assert.notEqual(publishing.sessionId, publisherForeground)
  await idle(origin)
  const foreground = await newPart(engineer.id)
  await send(foreground, other)
  await calls(other)
  await idle(foreground)
  archiveOrigin.resolve()

  for (const update of [progress, complete]) {
    const delivered = await calls(update, '[Message from')
    assert.equal(delivered.sessionId, origin, 'release update returns to the implementation conversation')
    assert.ok(JSON.stringify(delivered.body.messages).includes(implementation))
    assert.ok(!JSON.stringify(delivered.body.messages).includes(other))
  }
  assert.equal((await bot(engineer.id)).sessionId, foreground, 'the selected conversation stays selected')
  assert.deepEqual((await bot(engineer.id)).openParts.map(part => part.sessionId), [origin], 'returning updates only reopened the original conversation')
  await idle(origin)
  await idle(publishing.sessionId)

  await host.restart()
  await send(publishing.sessionId, 'Forward the late release update to the Bot that requested this release.')
  assert.equal((await calls(late, '[Message from')).sessionId, origin, 'the handoff survives restart and a later turn')
  await idle(publishing.sessionId)

  await send(foreground, next)
  const publishingOtherWork = await calls(handoff2, '[Message from')
  assert.notEqual(publishingOtherWork.sessionId, publishing.sessionId)
  assert.equal((await calls(complete2, '[Message from')).sessionId, foreground, 'a second handoff between the same Bots has its own origin')
  await idle(publishingOtherWork.sessionId)

  await send(publishing.sessionId, 'Assign a separate task to the same Bot.')
  const separate = await calls(unrelated, '[Message from')
  assert.notEqual(separate.sessionId, origin)
  assert.notEqual(separate.sessionId, foreground)
  await idle(origin)
  assert.equal(await host.bot('bot-open-part', { botId: engineer.id, sessionId: origin }), true)
  const transcript = await host.bot('chat', { botId: engineer.id })
  assert.equal(transcript.sessionId, origin)
  for (const text of [implementation, ...[progress, complete, late].map(report)]) {
    assert.ok(transcript.items.some(item => item.text?.includes(text)), 'the original chat shows ' + text)
  }
  assert.equal(transcript.items.filter(item => item.kind === 'event' && item.role === 'request' && item.name === publisherName).length, 3)
  assert.ok(!transcript.items.some(item => [other, complete2, unrelated].some(text => item.text?.includes(text))))
  note('handoff-routing', { origin, publishing: publishing.sessionId, foreground, separate: separate.sessionId })
}
