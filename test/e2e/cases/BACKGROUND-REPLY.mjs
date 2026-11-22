import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { member } from '../tickets.mjs'

// A Claude Code Bot starts a background task and ends its turn; the task ends a few
// seconds later and Claude answers it by itself (Claude Code 2.1 wakes the model with a
// task notification). That answer shows in the Bot's chat as a reply of its own: in the
// chat the phone reads, as a phone notice, in the web chat under its own line, with the
// unread mark while the chat is not open. Nothing more goes to the CLI for it, and the
// next message gets its own answer.
const AUTONOMOUS = 'autonomous: the background task finished'

export default async function BACKGROUND_REPLY(context) {
  const host = await context.makeHost()
  const fixture = new URL('../../external/fixtures/fake-claude-turns.mjs', import.meta.url)
  await writeFile(join(host.bin, 'claude'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('0.1.0 fixture');
else if (process.argv.includes('status')) console.log(JSON.stringify({ loggedIn: true }));
else import(${JSON.stringify(fixture.href)}).catch(e => { console.error(e); process.exit(1); });
`, { mode: 0o700 })
  await host.install(context.candidate)
  await host.start()
  const mainId = await openFullTeam(host)
  const bot = await member(host, 'Background Claude', 'local-claude-code/default')
  const items = async () => (await host.bot('chat', { botId: bot.id })).items ?? []
  const botTexts = async () => (await items()).filter(item => item.kind === 'bot').map(item => item.text)
  await until(async () => (await botTexts()).length > 0, bot.name + ' finished its setup greeting')

  const { page } = host
  const row = page.locator('.bt-row[data-bot-id="' + bot.id + '"]')
  await row.click()
  await page.locator('.bt-head .bt-pill-name').filter({ hasText: bot.name }).waitFor()
  const { boot, seq } = await host.bot('hello', {})
  await host.bot('send', { sessionId: bot.id, text: 'BACKGROUND 4000 task' })
  // The sidebar previews the same line: the chat's own paragraph is the one read here.
  await page.locator('p', { hasText: 'started a background task' }).first().waitFor()
  // The user moves to another chat before the task ends.
  await page.locator('[data-bot-id="' + mainId + '"]').first().click()
  await until(async () => (await row.getAttribute('aria-label'))?.includes('有未读') === false, bot.name + ' read before its task ends')

  const texts = await until(async () => {
    const shown = await botTexts()
    return shown.includes(AUTONOMOUS) && shown
  }, 'the answer Claude gave by itself in the chat the phone reads', 30_000)
  assert.equal(texts.at(-1), AUTONOMOUS)
  assert.equal(texts.at(-2), 'started a background task')
  // The message that opened its turn is no message of the user's, and never reached the
  // CLI: the fake CLI answers every prompt with "reply: <its last line>".
  const all = await items()
  assert.ok(!all.some(item => item.kind === 'user' && /Background turn/u.test(item.text ?? '')), 'no user message for the background turn')
  assert.ok(!texts.some(text => /Background turn/u.test(text)), 'the CLI got nothing for the background turn')

  const { notices } = await host.bot('notices', { boot, since: seq })
  assert.ok(notices.some(notice => notice.kind === 'message' && notice.botId === bot.id && notice.text === AUTONOMOUS), 'the phone hears of the answer')
  await until(async () => (await row.getAttribute('aria-label'))?.includes('有未读'), bot.name + ' marked unread for its answer')

  await row.click()
  await page.locator('.bt-head .bt-pill-name').filter({ hasText: bot.name }).waitFor()
  await page.locator('.bt-event').filter({ hasText: '后台任务有了新消息' }).first().waitFor()
  await page.locator('p', { hasText: AUTONOMOUS }).first().waitFor()
  assert.equal(await page.getByText('Background turn', { exact: false }).count(), 0)
  await host.capture('background-reply')

  await host.bot('send', { sessionId: bot.id, text: 'next' })
  const after = await until(async () => {
    const shown = await botTexts()
    return shown.at(-1) === 'reply: next' && shown
  }, bot.name + ' answers the next message', 30_000)
  assert.equal(after.filter(text => text === AUTONOMOUS).length, 1)
  context.note('background-reply', { botId: bot.id, replies: after.slice(-3), notices: notices.filter(notice => notice.botId === bot.id).length })
}
