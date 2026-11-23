import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

// New session in a Bot's own chat: the labelled button in the chat's top bar, the
// details panel and the sidebar menu each start one fresh part, the view stays on the
// Bot, and a part nobody has talked in yet (a greeting, or a New session just made)
// gets no second one on top. While the Bot works, the part it leaves keeps running in
// the background and the fresh one still opens as the Bot's own chat. Sessions are named
// by the first thing the user asked in them, and any of them opens while another works.
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
  await until(async () => /^新会话 · /u.test(await line.innerText()), 'the fresh part\'s line says when it began')
  await page.locator('.bt-part-fresh').waitFor()
  // Sessions show apart, as in DSH: nothing of the session it left is drawn above the
  // line, only a way back to it.
  const scroller = page.locator('[data-conversation-scroll]')
  assert.equal(await scroller.locator('.bt-earlier').count(), 0, 'no earlier session is stacked above the new one')
  assert.equal(await scroller.getByText('First question ' + tag, { exact: true }).count(), 0, 'the earlier session\'s messages stay in it')
  const back = page.locator('.bt-part-from button')
  await back.waitFor()
  assert.match(await back.innerText(), /上一个会话/u, 'the new session links to the one the user left')
  await until(async () => (await back.innerText()).includes('First question ' + tag), 'the link names the session by its first message')
  await host.capture('new-session-fresh-part')

  // Nothing in it yet: the button (quiet, but still clickable) and the host both leave
  // it as it is.
  await button.click({ force: true })
  assert.equal(await host.bot('bot-new-part', { botId: bot.id }), false, 'the host turns a New session on an empty part away')
  await staysAt(second, 'an empty part got no second New session')

  // The first message goes out with one opening, and nothing of the session it left:
  // a New session starts from zero, as a new chat does.
  const calls = host.model.calls.length
  await talk('Second question ' + tag)
  const sent = host.model.calls.slice(calls).filter(call => (call.body.tools ?? []).length > 0).map(call => JSON.stringify(call.body.messages))
  const handoffs = sent.map(text => (text.match(/\[Handoff · new conversation\]/gu) ?? []).length)
  assert.ok(handoffs.length > 0 && handoffs.every(count => count === 1), 'each request of the fresh part opens with one opening: ' + JSON.stringify(handoffs))
  assert.ok(sent.every(text => !text.includes('First question ' + tag) && !/\[Handoff · part \d+\]/u.test(text)), 'nothing of the session it left came over')
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

  const rows = page.locator('.bt-agent-session')
  // Each session is listed by the first thing the user asked in it.
  const openEarlier = async ({ session, message, otherMessage }) => {
    const label = message + tag
    await rows.getByText(label, { exact: true }).click()
    await until(async () => (await partsOf()).current === session, `${label} became the Bot's current part`)
    await scroller.getByText(message + tag, { exact: true }).waitFor()
    assert.equal(await scroller.getByText(otherMessage + tag, { exact: true }).count(), 0, 'the other transcript stays in its own session')
    assert.equal(await page.locator('.bt-agent-session.is-current .bt-agent-session-name').innerText(), label, 'the active row keeps the name the user clicked')
  }
  const firstSession = { session: first.current, message: 'First question ', otherMessage: 'Second question ' }
  const secondSession = { session: second.current, message: 'Second question ', otherMessage: 'First question ' }
  await openEarlier(firstSession)
  await openEarlier(secondSession)

  const reopenFirst = () => host.bot('bot-open-part', { botId: bot.id, sessionId: first.current })
  const repeated = await Promise.all([reopenFirst(), reopenFirst()])
  assert.deepEqual(repeated.toSorted(), [false, true], 'a repeated request switches to the same session once')
  assert.deepEqual(await partsOf(), { current: first.current, earlier: [second.current] })
  await openBotChat(host, bot)
  await openPanel()
  await openEarlier(secondSession)

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

  // The session list: newest first, the empty current session named for what it is and
  // every other one by the first thing the user asked in it.
  await openPanel()
  assert.equal(await panelButton.getAttribute('aria-disabled'), 'true')
  await until(async () => (await rows.count()) === 5, 'the panel lists the five sessions')
  const named = ['Fourth question ' + tag, 'Third question ' + tag, 'Second question ' + tag, 'First question ' + tag]
  let names
  await until(async () => {
    names = await page.locator('.bt-agent-session .bt-agent-session-name').allInnerTexts()
    return JSON.stringify(names) === JSON.stringify(['新会话', ...named])
  }, 'the sessions are named by their first message, newest first').catch((error) => { throw new Error(error.message + ' ' + JSON.stringify(names)) })
  await host.capture('new-session-details-panel')

  // While the Bot is working, a New session leaves the part it works in running in the
  // background and opens one with nothing carried over. That part still opens with a turn
  // of its own: DSH takes a Session no turn has started in for a blank conversation and
  // swaps the Bot's message box for its workspace picker.
  const holds = new Map()
  const replies = host.model.reply
  host.model.reply = async (body, call) => {
    const last = JSON.stringify(body.messages.at(-1) ?? '')
    for (const [text, held] of holds) {
      if (!last.includes(text)) continue
      await held
      return 'Answer to ' + text
    }
    return replies(body, call)
  }
  const state = () => host.bot('state')
  const threadNow = async () => {
    const value = (await state()).bots.find(entry => entry.id === bot.id)
    return { current: value.sessionId ?? value.id, earlier: value.parts ?? [], open: (value.openParts ?? []).map(part => part.sessionId) }
  }
  const busyNewSession = async (text) => {
    let release
    holds.set(text, new Promise(resolve => { release = resolve }))
    const before = await threadNow()
    await host.bot('send', { sessionId: bot.id, text })
    await until(() => host.model.calls.some(call => JSON.stringify(call.body.messages.at(-1) ?? '').includes(text)), 'the Bot is working on ' + text)
    await waitState('ready', 'the working part was talked in')
    const clickedAt = Date.now()
    await button.click()
    const after = await until(async () => {
      const now = await threadNow()
      return now.current !== before.current ? now : undefined
    }, 'a New session while the Bot works opened a fresh part')
    return { release, left: before.current, after, clickedAt }
  }

  const busyText = 'Busy question ' + tag
  const busy = await busyNewSession(busyText)
  assert.deepEqual(busy.after.earlier, [], 'the fresh part begins a thread of its own')
  assert.deepEqual(busy.after.open, [busy.left], 'the part it left goes on in the background')
  assert.equal((await state()).partsRunning?.[busy.left], true, 'the part it left is still working')
  await waitState('empty', 'the busy-time part reads as a new session')
  const busyHint = page.locator('.bt-part-fresh[data-opening]')
  await busyHint.waitFor()
  assert.match(await busyHint.innerText(), /会话列表/u, 'the hint says where the earlier conversation went')
  assert.equal(await page.locator('[class*="composerHero"]').count(), 0, 'the Bot keeps its own message box, not DSH\'s workspace picker')
  const top = await host.bot('earlier', { sessionId: busy.after.current })
  assert.ok(top.startedAt >= busy.clickedAt - 5000, 'the new thread begins when it was made, not with the Bot: ' + top.startedAt)
  // The opening turn is answered with the fixed line. Godbot's own requests (a memory
  // review of the earlier messages, say) may name the part too; a turn carries the
  // Bot's tools.
  await until(async () => (await state()).partsRunning?.[busy.after.current] !== true, 'the opening turn ended')
  const openingTurns = host.model.calls.filter(call => call.sessionId === busy.after.current && (call.body.tools ?? []).length > 0)
  assert.equal(openingTurns.length, 0, 'opening the part asked the model nothing')
  const opened = await host.bot('chat', { botId: bot.id })
  assert.equal(opened.sessionId, busy.after.current)
  assert.ok(!opened.items.some(item => item.kind === 'bot'), 'the opening shows no reply: ' + JSON.stringify(opened.items))
  await openPanel()
  // The earlier sessions went on with the running one's thread and stay in the list.
  await until(async () => JSON.stringify(await page.locator('.bt-agent-session .bt-agent-session-name').allInnerTexts()) === JSON.stringify(['新会话', busyText, ...named]),
    'the panel lists the new session, the one still running and the earlier ones')
  assert.equal(await rows.nth(1).locator('.bt-agent-session-run').count(), 1, 'the background session is marked running')
  await page.locator('.bt-agent-sessions-warn').waitFor()
  await host.capture('new-session-busy-fresh-part')

  // The part it left answers in the background. Going back to it leaves the busy-time
  // part nobody talked in out of the list.
  busy.release()
  await until(async () => (await state()).partsRunning?.[busy.left] !== true, 'the background part finished its answer')
  await rows.nth(1).click()
  await until(async () => (await threadNow()).current === busy.left, 'the background part became current again')
  await until(async () => (await state()).emptyParts?.[bot.id]?.includes(busy.after.current), 'the host counts the busy-time part as empty')
  // The part it went back to and its four earlier ones, all talked in; the busy-time part
  // would make a sixth row.
  let listed
  await until(async () => {
    listed = await page.locator('.bt-agent-session').allInnerTexts()
    return listed.length === 5
  }, 'the list leaves the empty busy-time part out').catch(async (error) => {
    const now = await state()
    const value = now.bots.find(entry => entry.id === bot.id)
    throw new Error(error.message + ' ' + JSON.stringify({ listed, panel: await panelButton.isVisible(), current: value.sessionId, parts: value.parts, open: value.openParts, empty: now.emptyParts?.[bot.id], running: now.partsRunning }))
  })
  await page.getByText('Answer to ' + busyText).first().waitFor()

  // A busy-time part answers like any other once the user talks in it, with nothing from
  // the part it left.
  const againText = 'Busy again ' + tag
  const again = await busyNewSession(againText)
  await waitState('empty', 'the second busy-time part reads as a new session')
  const beforeTalk = host.model.calls.length
  await talk('After the busy one ' + tag)
  // The part's own turns; a memory review that names the part carries no tools.
  const freshCalls = host.model.calls.slice(beforeTalk)
    .filter(call => call.sessionId === again.after.current && (call.body.tools ?? []).length > 0)
    .map(call => JSON.stringify(call.body.messages))
  assert.ok(freshCalls.length > 0, 'the busy-time part asked the model')
  assert.ok(freshCalls.every(text => (text.match(/\[Handoff · new conversation\]/gu) ?? []).length === 1), 'each request opens with the one opening')
  assert.ok(freshCalls.every(text => !text.includes(againText) && !text.includes(busyText)), 'nothing from the part it left came over')
  again.release()
  await until(async () => (await state()).partsRunning?.[again.left] !== true, 'the second background part finished its answer')

  // While the Bot works, any earlier session opens, one of the background thread's
  // included: the session at work goes on in the background, and the one opened takes the
  // user's messages at once instead of waiting for the other to finish.
  const parallelText = 'Parallel question ' + tag
  let releaseParallel
  holds.set(parallelText, new Promise(resolve => { releaseParallel = resolve }))
  const working = (await threadNow()).current
  await host.bot('send', { sessionId: bot.id, text: parallelText })
  await until(() => host.model.calls.some(call => JSON.stringify(call.body.messages.at(-1) ?? '').includes(parallelText)), 'the Bot is working on ' + parallelText)
  await openPanel()
  await rows.filter({ hasText: 'First question ' + tag }).click()
  await until(async () => (await threadNow()).current === first.current, 'an earlier session opened while the Bot works')
  assert.ok((await threadNow()).open.includes(working), 'the session at work went on in the background')
  assert.equal((await state()).partsRunning?.[working], true, 'and is still working')
  await scroller.getByText('First question ' + tag, { exact: true }).waitFor()
  assert.equal(await page.locator('.bt-error[role=alert]').count(), 0, 'opening it reported no error')
  const composer = page.locator('[data-composer-card] [role=textbox]')
  const meanwhile = 'Meanwhile ' + tag
  await composer.fill(meanwhile)
  await composer.press('Enter')
  await until(() => host.model.calls.some(call => call.sessionId === first.current && JSON.stringify(call.body.messages).includes(meanwhile)), 'the opened session answers while the other one works')
  assert.equal((await state()).partsRunning?.[working], true, 'the background session is still working')
  // The chat's top bar lists the Bot's sessions in a menu, the running one marked and the
  // open one checked; the sidebar lists none.
  const menuButton = page.locator('.bt-head .bt-smenu-btn')
  const menuItems = page.locator('.bt-smenu-item')
  const openMenu = async () => {
    if (await menuItems.count() > 0) return
    await menuButton.click()
    await menuItems.first().waitFor()
  }
  const closeMenu = async () => {
    if (await menuItems.count() === 0) return
    await menuButton.click()
    await menuItems.first().waitFor({ state: 'detached' })
  }
  await until(async () => (await menuButton.locator('.bt-smenu-dot').count()) === 1, 'the menu button shows a session at work elsewhere')
  await openMenu()
  const workingItem = menuItems.filter({ hasText: 'After the busy one ' + tag })
  await until(async () => (await workingItem.getAttribute('data-tone').catch(() => null)) === 'run', 'the menu marks the session at work')
  assert.equal(await menuItems.filter({ hasText: 'First question ' + tag }).getAttribute('aria-checked'), 'true', 'the menu checks the open session')
  assert.equal(await page.locator('.bt-bot-sub-row, .bt-bot-sub').count(), 0, 'the sidebar lists no sessions')
  // Once it has settled, every row is on top: the transcript under the top bar never
  // draws over the list.
  await delay(400)
  assert.ok(await menuItems.evaluateAll(items => items.every((item) => {
    const box = item.getBoundingClientRect()
    return item.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
  })), 'the session menu is drawn above the transcript')
  await host.capture('new-session-open-earlier-while-busy')
  await closeMenu()
  releaseParallel()
  await until(async () => (await state()).partsRunning?.[working] !== true, 'the background session finished its answer')
  await until(async () => (await state()).partsRunning?.[first.current] !== true, 'the opened session finished its answer')
  // Back to it from the menu; its answer is there.
  await openMenu()
  await workingItem.click()
  await until(async () => (await threadNow()).current === working, 'the menu opened the session that worked in the background')
  await scroller.getByText('Answer to ' + parallelText).first().waitFor()
  // An earlier session of a background thread opens while the Bot is idle too: the idle
  // one joins the earlier sessions.
  await openPanel()
  await rows.filter({ hasText: 'Second question ' + tag }).click()
  await until(async () => (await threadNow()).current === second.current, 'an earlier session of a background thread opened')
  assert.ok((await threadNow()).earlier.includes(working), 'the idle session joined the earlier ones')

  // Opening an older session leaves the Bot where it is in the sidebar: Bots sort by
  // their latest activity in any of their sessions, not by the one that is open.
  const witness = await host.bot('create-bot', { name: 'Order Witness', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: witness.id })).items?.some(item => item.kind === 'bot'), 'the second Bot greeted the user')
  await talk('Latest ' + tag)
  const rowOrder = () => page.locator('.bt-row[data-bot-id]').evaluateAll(found => found.map(row => row.dataset.botId))
  await until(async () => {
    const ids = await rowOrder()
    return ids.includes(witness.id) && ids.indexOf(bot.id) < ids.indexOf(witness.id)
  }, 'the Bot that talked last is listed first')
  const orderBefore = await rowOrder()
  await openMenu()
  await menuItems.filter({ hasText: 'First question ' + tag }).click()
  await until(async () => (await threadNow()).current === first.current, 'the oldest session opened from the menu')
  await delay(1500)
  assert.deepEqual(await rowOrder(), orderBefore, 'opening an older session left the Bot where it was in the sidebar')

  // The names come back after a restart: each one is read from its session's record,
  // archived sessions included, as for sessions made before names were kept.
  await host.restart()
  const expected = { [first.current]: 'First question ' + tag, [second.current]: 'Second question ' + tag, [third.current]: 'Third question ' + tag, [fourth.current]: 'Fourth question ' + tag, [working]: 'After the busy one ' + tag }
  let restored
  await until(async () => {
    restored = (await host.bot('state')).partTitles ?? {}
    return Object.entries(expected).every(([id, title]) => restored[id] === title)
  }, 'the session names were read back after a restart').catch((error) => { throw new Error(error.message + ' ' + JSON.stringify(restored)) })

  // A New session opens at once: none of them asked the model for a handoff note.
  const noteAsks = host.model.calls.filter(call => JSON.stringify(call.body).includes('Your conversation is long')).length
  assert.equal(noteAsks, 0, 'no New session asked the model for a handoff note')
  note('new-session', { botId: bot.id, parts: [first, second, third, fourth, fifth].map(parts => parts.current), handoffsPerRequest: handoffs, busyParts: [busy.after.current, again.after.current] })
}
