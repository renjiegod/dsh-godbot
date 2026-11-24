import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

// A 1×1 PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

// An image added to a Bot chat's composer is still there after the user opens another
// chat and comes back, together with the text, and it goes out with the message.
export default async function draftAttachments({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const { page } = host
  const tag = randomUUID().slice(0, 8)
  host.model.reply = () => 'Fixture reply ' + tag
  const first = await host.bot('create-bot', { name: 'Draft Keeper', model: 'deepseek-official/deepseek-flash' })
  const other = await host.bot('create-bot', { name: 'Draft Visitor', model: 'deepseek-official/deepseek-flash' })
  for (const bot of [first, other]) {
    await until(async () => (await host.bot('chat', { botId: bot.id })).items?.some(item => item.kind === 'bot'), bot.name + ' greeted the user')
  }

  const composer = page.locator('[data-composer-card]').first()
  const tiles = composer.locator('[data-slot="conversation.input.attachments"] [role="group"] > *')
  const box = composer.locator('[role=textbox][contenteditable=true]')
  const imageName = 'draft-' + tag + '.png'
  const text = 'Look at this ' + tag

  await openBotChat(host, first)
  await composer.locator('input[type=file]').setInputFiles({ name: imageName, mimeType: 'image/png', buffer: PIXEL })
  await until(async () => (await tiles.count()) === 1, 'the image joined the draft')
  await box.click()
  await page.keyboard.type(text)
  await host.capture('draft-attachments-before')

  await openBotChat(host, other)
  await until(async () => (await tiles.count()) === 0, 'the other Bot\'s chat has its own empty draft')
  await openBotChat(host, first)
  await until(async () => (await tiles.count()) === 1, 'the image is still in the draft after coming back')
  await until(async () => (await box.innerText()).includes(text), 'the text is still in the draft after coming back')
  await host.capture('draft-attachments-after')

  const before = host.model.calls.length
  await page.keyboard.press('Enter')
  await until(async () => (await tiles.count()) === 0, 'sending emptied the draft')
  const call = await until(async () => host.model.calls.slice(before).find(entry => JSON.stringify(entry.body.messages).includes(text)), 'the message reached the model')
  const sent = JSON.stringify(call.body.messages)
  assert.ok(/image/u.test(sent) && sent.includes(PIXEL.toString('base64').slice(0, 24)), 'the held image went out with the message')
  note('draft-attachments', { botId: first.id, image: imageName })
}
