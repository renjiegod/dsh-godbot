import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

// The last reply's toolbar must remain inside the scrolling viewport and be
// clickable when the input card is immediately below it.
export default async function conversationTools({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await host.bot('set-prefs', { layout: 'conversation' })
  await openFullTeam(host)
  const bot = await host.bot('create-bot', { name: 'Toolbar Tester', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: bot.id })).items?.some(item => item.kind === 'bot'), 'the Bot finished its greeting')
  await openBotChat(host, bot)
  const { page } = host
  const marker = 'Toolbar reply ' + randomUUID()
  host.model.reply = () => marker + '\n\n' + Array.from({ length: 25 }, (_, i) => `Line ${i + 1}: This reply fills the scroll area.`).join('\n\n')
  const composer = page.locator('[data-composer-card] [role=textbox]')
  await composer.fill('Check the last reply toolbar')
  await composer.press('Enter')
  const message = page.locator('[data-conversation-scroll] .bt-msg').filter({ hasText: marker }).last()
  await message.waitFor()
  await message.getByText('Line 25: This reply fills the scroll area.', { exact: true }).waitFor()
  await message.locator('.bt-tools').waitFor({ state: 'attached' })
  const scroller = page.locator('[data-conversation-scroll]')
  const cases = []
  for (const viewport of [{ width: 1280, height: 800 }, { width: 430, height: 780 }]) {
    await page.setViewportSize(viewport)
    for (const multiline of [false, true]) {
      await composer.fill(multiline ? 'A longer draft\nwith another line\nand a third line' : '')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await scroller.evaluate(node => { node.scrollTop = node.scrollHeight })
      const bubble = message.locator('.bt-bubble')
      const bubbleBox = await bubble.boundingBox()
      assert.ok(bubbleBox, 'the last reply has a visible bubble')
      await page.mouse.move(bubbleBox.x + 10, bubbleBox.y + bubbleBox.height - 4)
      const more = message.locator('.bt-tools button[aria-haspopup="menu"]')
      await more.waitFor({ state: 'visible' })
      const geometry = await more.evaluate(button => {
        const box = button.getBoundingClientRect()
        const scroll = button.closest('[data-conversation-scroll]').getBoundingClientRect()
        const composer = document.querySelector('[data-composer-card]').getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { top: box.top, bottom: box.bottom, scrollTop: scroll.top, scrollBottom: scroll.bottom,
          composerTop: composer.top, receivesPointer: !!hit && (button === hit || button.contains(hit)) }
      })
      assert.ok(geometry.top >= geometry.scrollTop && geometry.bottom <= geometry.scrollBottom,
        'the full toolbar button is inside the scroll viewport: ' + JSON.stringify(geometry))
      assert.ok(geometry.bottom <= geometry.composerTop && geometry.receivesPointer,
        'the toolbar is unobstructed by the input card: ' + JSON.stringify(geometry))
      await more.click()
      const menu = page.locator('.bt-menu[role="menu"]')
      await menu.waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      cases.push({ viewport, multiline, ...geometry })
    }
    await host.capture('conversation-tools-' + viewport.width)
  }
  note('conversation-tools-visible-and-clickable', { cases })
}
