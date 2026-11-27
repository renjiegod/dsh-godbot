import assert from 'node:assert/strict'
import { until } from '../host.mjs'

// Work handed on outside message_bot leaves no recorded origin. A Bot that was told the
// originating conversation's session ID still reaches it: by naming it in the text, or
// with message_bot's conversation argument. A session ID that is not the other Bot's
// is refused rather than guessed.
export default async function botConversationReference({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()

  const engineerName = 'Implementation Bot'
  const publisherName = 'Release Bot'
  const implementation = 'Build the warehouse barcode dashboard and hand it to the release bot.'
  const elsewhere = 'Plan the quarterly offsite agenda.'
  const handoff = 'Publish the warehouse barcode dashboard. The originating conversation is '
  const finished = 'Release finished for the dashboard. Verify the public package in the originating conversation '
  const checksum = 'The relay now serves the same package checksum.'
  const verified = 'Verified in the original conversation.'
  let origin
  let publisherPart
  const tool = input => [{ type: 'tool_use', name: 'message_bot', input: { to: engineerName, ...input } }]
  host.model.reply = async body => {
    const last = JSON.stringify(body.messages?.findLast(message => message.role === 'user')?.content ?? '')
    if (last.includes('tool_result')) return 'Fixture acknowledged.'
    if (last.includes(handoff)) return tool({ message: finished + origin + '.' })
    if (last.includes('Send the checksum note')) return tool({ message: checksum, conversation: origin })
    if (last.includes('Send a note to the wrong conversation')) return tool({ message: checksum, conversation: publisherPart })
    if (last.includes('Send a note both ways')) return tool({ message: checksum, conversation: origin, new_conversation: true })
    if (last.includes('[Message from') && (last.includes(finished) || last.includes(checksum))) return verified
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
  const toolResult = text => calls(text, 'tool_result')
  for (const id of [engineer.id, publisher.id]) {
    await until(async () => (await host.bot('chat', { botId: id })).items.some(item => item.kind === 'bot'), 'setup greeting')
    await idle(id)
  }

  origin = (await bot(engineer.id)).sessionId
  publisherPart = (await bot(publisher.id)).sessionId
  await send(origin, implementation)
  await calls(implementation)
  await idle(origin)
  const backgroundBefore = (await bot(engineer.id)).openParts?.length ?? 0

  // The handoff is written into the publisher's chat by hand, so no delivery links the
  // two conversations; only the session ID in the text does.
  await send(publisherPart, handoff + origin + '.')
  const mentioned = await calls(finished, '[Message from')
  assert.equal(mentioned.sessionId, origin, 'a message naming the originating conversation by session ID goes there')
  assert.ok(JSON.stringify(mentioned.body.messages).includes(implementation))
  await toolResult('the conversation your message names by session ID')
  assert.equal((await bot(engineer.id)).openParts?.length ?? 0, backgroundBefore, 'no new conversation opened')
  await idle(origin)
  await idle(publisherPart)

  // The originating conversation has been archived by a New session; naming it reopens
  // it beside the conversation the user has selected.
  const before = (await bot(engineer.id)).sessionId
  assert.equal(await host.bot('bot-new-part', { botId: engineer.id }), true)
  const foreground = await until(async () => {
    const value = await bot(engineer.id)
    return value.sessionId !== before && value.parts.includes(before) && value.sessionId
  }, 'a fresh session archived ' + before)
  await send(foreground, elsewhere)
  await calls(elsewhere)
  await idle(foreground)
  await send(publisherPart, 'Send the checksum note to the requester.')
  const named = await calls(checksum, '[Message from')
  assert.equal(named.sessionId, origin, 'the named conversation gets the message')
  assert.ok(JSON.stringify(named.body.messages).includes(implementation))
  assert.ok(!JSON.stringify(named.body.messages).includes(elsewhere))
  await toolResult('the conversation you named')
  assert.equal((await bot(engineer.id)).sessionId, foreground, 'the selected conversation stays selected')
  await idle(origin)
  await idle(publisherPart)

  // A session ID of another Bot, or a request for a new conversation as well, is refused.
  await send(publisherPart, 'Send a note to the wrong conversation.')
  await toolResult(`is not one of ${engineerName}'s conversations`)
  await idle(publisherPart)
  await send(publisherPart, 'Send a note both ways.')
  await toolResult('Send with only one of them')
  await idle(publisherPart)
  const requests = (await host.bot('exchange', { a: publisher.id, b: engineer.id })).filter(row => row.role === 'request')
  assert.equal(requests.length, 2, 'the refused messages were not sent')
  note('conversation-reference', { origin, foreground, publisher: publisherPart })
}
