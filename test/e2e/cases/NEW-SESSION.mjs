import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

// New session in a Bot's own chat: the labelled button in the chat's top bar, the
// details panel and the sidebar menu each start one fresh part, the view stays on the
// Bot, and a part nobody has talked in yet (a greeting, or a New session just made)
// gets no second one on top.
export default async function newSession({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const { page } = host
  const tag = randomUUID().slice(0, 8)
  host.model.reply = body => 'Fixture reply ' + tag + ' #' + body.messages.length
  const bot = await host.bot('create-bot', { name: 'Session Tester', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: bot.id })).items?.some(item => item.kind === 'bot'), 'the Bot greeted the user')
  await openBotChat(host, bot)

  const button = page.locator('.bt-head .bt-new-session')
  // The state of this Bot's button: the chat on screen must stay this Bot's throughout.
  const stateOf = async () => {
    const name = await page.locator('.bt-head .bt-pill-name').first().textContent({ timeout: 1000 }).catch(() => '')
    return name?.trim().startsWith(bot.name) ? button.getAttribute('data-state', { timeout: 1000 }).catch(() => null) : 'away'
  }
  const waitState = (wanted, why) => until(async () => (await stateOf()) === wanted, why)
  const partsOf = async () => {
    const value = (await host.bot('state')).bots.find(entry => entry.id === bot.id)
    return { current: value.sessionId ?? value.id, earlier: value.parts ?? [] }
  }
  const talk = async (text) => {
    await host.bot('send', { sessionId: bot.id, text })
    await until(async () => (await host.bot('chat', { botId: bot.id })).items?.some(item => item.kind === 'user' && item.text?.includes(text)), 'the message reached the current part')
    await waitState('ready', 'the part was talked in')
  }
  // Waits as long as the fixture takes to move a part on, then checks that none moved.
  const staysAt = async (parts, why) => {
    await delay(2500)
    assert.deepEqual(await partsOf(), parts, why)
  }

  // A part with only the Bot's greeting is already a fresh conversation.
  await waitState('empty', 'a greeting-only part reads as a new session')
  assert.equal(await button.getAttribute('aria-disabled'), 'true')
  assert.equal(await button.innerText(), '新会话')
  const first = await partsOf()
  assert.equal(await host.bot('bot-new-part', { botId: bot.id }), false, 'the host turns a New session on a greeting-only part away')
  await staysAt(first, 'a greeting-only part got no New session')

  await talk('First question ' + tag)
  await host.capture('new-session-top-bar-ready')
  await button.click()
  const second = await until(async () => {
    const parts = await partsOf()
    return parts.earlier.length === 1 && parts.current !== first.current ? parts : undefined
  }, 'the button started a fresh part')
  await waitState('empty', 'the fresh part reads as a new session')
  const line = page.locator('.bt-part-line[data-fresh]')
  await line.waitFor()
  assert.match(await line.innerText(), /^新会话 · /u)
  await page.locator('.bt-part-fresh').waitFor()
  await host.capture('new-session-fresh-part')

  // Nothing in it yet: the button (quiet, but still clickable) and the host both leave
  // it as it is.
  await button.click({ force: true })
  assert.equal(await host.bot('bot-new-part', { botId: bot.id }), false, 'the host turns a New session on an empty part away')
  await staysAt(second, 'an empty part got no second New session')

  // The first message goes out with one handoff package, not a stack of them.
  const calls = host.model.calls.length
  await talk('Second question ' + tag)
  const sent = host.model.calls.slice(calls).map(call => JSON.stringify(call.body.messages))
  const handoffs = sent.map(text => (text.match(/\[Handoff · part \d+\]/gu) ?? []).length)
  assert.ok(handoffs.length > 0 && handoffs.every(count => count === 1), 'each request of the fresh part carries one handoff: ' + JSON.stringify(handoffs))
  assert.ok(sent.some(text => text.includes('because the user started a new session')), 'the handoff says Godbot put it together for a New session')
  await page.locator('.bt-part-fresh').waitFor({ state: 'detached' })

  // The details panel starts the next one from the row above its session list.
  const panelButton = page.locator('.bt-new-session-panel')
  const openPanel = async () => {
    if (await panelButton.isVisible()) return
    await page.locator('.bt-head .bt-pill').click()
    await panelButton.waitFor()
  }
  await openPanel()
  assert.equal(await panelButton.getAttribute('data-state'), 'ready')
  await host.capture('new-session-details-panel-ready')
  await panelButton.click()
  const third = await until(async () => {
    const parts = await partsOf()
    return parts.earlier.length === 2 ? parts : undefined
  }, 'the details panel started a fresh part')
  await waitState('empty', 'the panel part reads as a new session')

  // Two clicks in a row make one part.
  await talk('Third question ' + tag)
  await button.dblclick()
  const fourth = await until(async () => {
    const parts = await partsOf()
    return parts.earlier.length === 3 ? parts : undefined
  }, 'a double click started a fresh part')
  await waitState('empty', 'the double-click part reads as a new session')
  await staysAt(fourth, 'a double click made one part')

  // The sidebar row offers a New session only while there is something to leave.
  const row = page.locator(`[data-bot-id="${bot.id}"]`)
  const menuItem = page.getByRole('menuitem', { name: '新会话', exact: true })
  await row.click({ button: 'right' })
  await page.getByRole('menu').waitFor()
  assert.equal(await menuItem.count(), 0, 'an empty session offers no New session in the menu')
  await page.keyboard.press('Escape')
  await talk('Fourth question ' + tag)
  await row.click({ button: 'right' })
  await menuItem.click()
  const fifth = await until(async () => {
    const parts = await partsOf()
    return parts.earlier.length === 4 ? parts : undefined
  }, 'the sidebar menu started a fresh part')
  await waitState('empty', 'the menu part reads as a new session')

  // The session list: the empty current session first, then the earlier ones by number.
  await openPanel()
  assert.equal(await panelButton.getAttribute('aria-disabled'), 'true')
  const rows = page.locator('.bt-agent-session')
  await until(async () => (await rows.count()) === 5, 'the panel lists the five sessions')
  const names = await page.locator('.bt-agent-session .bt-agent-session-name').allInnerTexts()
  assert.equal(names[0], '新会话', 'the empty current session is named for what it is')
  assert.ok(names.slice(1).every(name => /^会话 \d+$/u.test(name)), 'earlier sessions are numbered, not all named after the Bot: ' + JSON.stringify(names))
  await host.capture('new-session-details-panel')
  // A New session opens at once: none of them asked the model for a handoff note.
  const noteAsks = host.model.calls.filter(call => JSON.stringify(call.body).includes('Your conversation is long')).length
  assert.equal(noteAsks, 0, 'no New session asked the model for a handoff note')
  note('new-session', { botId: bot.id, parts: [first, second, third, fourth, fifth].map(parts => parts.current), handoffsPerRequest: handoffs })
}
