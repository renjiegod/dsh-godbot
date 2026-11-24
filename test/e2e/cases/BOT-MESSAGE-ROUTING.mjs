import assert from 'node:assert/strict'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

export default async function botMessageRouting({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)

  const wallet = 'Review wallet reconciliation discrepancies in OPS-213'
  const catering = 'Plan the vegetarian catering menu for Friday lunch'
  const translation = 'Translate the launch announcement into Japanese'
  const followup = 'Review the Japanese launch announcement translation'
  const inventory = 'Count barcode scanners in the warehouse inventory'
  const inventoryResult = 'There are seventeen barcode scanners.'
  const entry = 'I will read the inventory result in this conversation.'
  const after = 'Outline a weekend cycling itinerary in Taipei'
  const beforeRestart = 'Verify the Japanese launch announcement wording before release'
  const queued = 'Check the Japanese launch announcement wording after restart'
  const gate = Promise.withResolvers()
  const foregroundGate = Promise.withResolvers()
  const restartGate = Promise.withResolvers()
  const sends = new Set()
  const tasks = new Map([
    ['Dispatch the wallet request', { message: 'Validate OPS-213 wallet reconciliation totals', reply_to: 'user' }],
    ['Dispatch the translation request', { message: translation, reply_to: 'user' }],
    ['Dispatch the translation followup', { message: followup, reply_to: 'user', when: 'queue' }],
    ['Dispatch the queued translation request', { message: queued, reply_to: 'user', when: 'queue' }],
    [entry, { message: inventory }],
  ])
  const recipientName = 'Routing Worker'
  host.model.reply = async body => {
    const input = JSON.stringify(body.messages?.findLast(message => message.role === 'user')?.content ?? '')
    for (const [trigger, args] of tasks) {
      if (input.includes(trigger) && !sends.has(trigger)) {
        sends.add(trigger)
        return [{ type: 'tool_use', name: 'message_bot', input: { to: recipientName, ...args } }]
      }
    }
    if (input.includes('[Message from') && input.includes(inventory)) {
      await gate.promise
      return inventoryResult
    }
    if (input.includes('[Reply from') && input.includes(inventoryResult)) return 'Inventory result received.'
    if (input.includes('[Message from') && input.includes(translation)) return 'Japanese announcement prepared.'
    if (input.includes(catering)) await foregroundGate.promise
    if (input.includes(beforeRestart)) await restartGate.promise
    return 'Fixture acknowledged.'
  }

  const makeBot = name => host.bot('create-bot', { name, model: 'deepseek-official/deepseek-flash' })
  const recipient = await makeBot(recipientName)
  const sender = await makeBot('Routing Sender')
  const roster = () => host.bot('state')
  const bot = async id => (await roster()).bots.find(value => value.id === id)
  const chat = id => host.bot('chat', { botId: id })
  const idle = id => until(async () => (await roster()).partsRunning?.[id] !== true, 'turn finished in ' + id)
  const send = (sessionId, text) => host.bot('send', { sessionId, text })
  const modelCall = (text, header) => until(() => host.model.calls.find(call => {
    const input = JSON.stringify(call.body.messages?.findLast(message => message.role === 'user')?.content ?? '')
    return input.includes(text) && input.includes(header)
  }), 'model received ' + text, 15_000)
  const newPart = async id => {
    const before = (await bot(id)).sessionId
    assert.equal(await host.bot('bot-new-part', { botId: id }), true)
    return until(async () => {
      const value = await bot(id)
      return value.sessionId !== before && value.parts.includes(before) && value.sessionId
    }, 'a fresh session archived ' + before)
  }
  for (const id of [recipient.id, sender.id]) {
    await until(async () => (await chat(id)).items.some(item => item.kind === 'bot'), 'setup greeting')
    await idle(id)
  }
  const archived = (await bot(recipient.id)).sessionId
  await send(archived, wallet)
  await modelCall(wallet, '')
  await idle(archived)
  const foreground = await newPart(recipient.id)
  await send(foreground, catering)
  await modelCall(catering, '')
  await openBotChat(host, recipient)

  const senderPart = (await bot(sender.id)).sessionId
  await send(senderPart, 'Dispatch the wallet request')
  const related = await modelCall(tasks.get('Dispatch the wallet request').message, '[Message from')
  assert.equal(related.sessionId, archived, 'a related request reopens the matching archived conversation')
  assert.ok(JSON.stringify(related.body.messages).includes(wallet))
  assert.ok(!JSON.stringify(related.body.messages).includes(catering))
  await idle(senderPart)

  await send(senderPart, 'Dispatch the translation request')
  const unrelated = await modelCall(translation, '[Message from')
  assert.notEqual(unrelated.sessionId, foreground)
  assert.notEqual(unrelated.sessionId, archived)
  const input = JSON.stringify(unrelated.body.messages)
  assert.ok(!input.includes(wallet) && !input.includes(catering), 'the new conversation starts without earlier topics')
  assert.equal((await bot(recipient.id)).sessionId, foreground)
  assert.equal((await roster()).partsRunning[foreground], true, 'the unrelated turn kept running')
  foregroundGate.resolve()
  await idle(unrelated.sessionId)
  await idle(senderPart)

  await send(senderPart, 'Dispatch the translation followup')
  const continued = await modelCall(followup, '[Message from')
  assert.equal(continued.sessionId, unrelated.sessionId, 'the queued followup uses the existing background conversation')
  await idle(senderPart)
  assert.equal((await bot(recipient.id)).openParts.length, 2)
  await host.page.locator('.bt-head .bt-smenu-btn').click()
  await host.page.getByRole('menuitemradio', { name: new RegExp(translation, 'u') }).click()
  await host.page.getByText('Japanese announcement prepared.', { exact: true }).waitFor()
  assert.equal((await bot(recipient.id)).sessionId, unrelated.sessionId)
  await host.capture('routed-bot-conversation')

  await send(senderPart, entry)
  const waiting = await modelCall(inventory, '[Message from')
  assert.notEqual(waiting.sessionId, unrelated.sessionId)
  await idle(senderPart)
  const newer = await newPart(sender.id)
  await send(newer, after)
  await modelCall(after, '')
  gate.resolve()
  const returned = await modelCall(inventoryResult, '[Reply from')
  assert.equal(returned.sessionId, senderPart, 'a reply reopens the conversation that sent the request')
  assert.ok(!JSON.stringify(returned.body.messages).includes(after))
  assert.equal((await bot(sender.id)).sessionId, newer)
  await idle(newer)

  await send(unrelated.sessionId, beforeRestart)
  await modelCall(beforeRestart, '')
  await send(newer, 'Dispatch the queued translation request')
  await until(async () => (await host.bot('exchange', { a: sender.id, b: recipient.id })).some(row => row.role === 'request' && row.text === queued), 'the followup is queued for the running conversation')
  await host.restart()
  restartGate.resolve()
  const replay = await modelCall(queued, '[Message from')
  assert.equal(replay.sessionId, unrelated.sessionId, 'the queued request keeps its selected conversation after restart')
  assert.ok(!JSON.stringify(replay.body.messages).includes(catering))
  note('conversation-routing', { related: related.sessionId, foreground, unrelated: unrelated.sessionId, reply: returned.sessionId, replay: replay.sessionId })
}
