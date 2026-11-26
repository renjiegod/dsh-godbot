import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

export default async function newSessionAfterHandoff({ makeHost, candidate, note }) {
  const host = await makeHost()
  const fixture = new URL('../../external/fixtures/fake-codex.mjs', import.meta.url)
  await writeFile(join(host.bin, 'codex'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('codex-cli 0.171.0 fixture');
else if (process.argv.includes('status')) console.log('Logged in using ChatGPT');
else import(${JSON.stringify(fixture.href)}).catch(error => { console.error(error); process.exitCode = 1; });
`, { mode: 0o700 })
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const bot = await host.bot('create-bot', { name: 'Codex handoff tester', model: 'local-codex-cli/default' })
  const chat = cursor => host.bot('chat', { botId: bot.id, cursor })
  const state = () => host.bot('state')
  const first = await until(async () => {
    const current = await chat()
    return current.items.some(item => item.kind === 'bot') && current.sessionId
  }, 'Codex greeted the user')

  // The fixture reports a context size past the hard limit after this turn.
  const prompt = 'Finish the Codex fixture task grow:430000'
  await host.bot('send', { sessionId: first, text: prompt })
  const continued = await until(async () => {
    const current = await chat()
    if (current.sessionId === first || !current.items.some(item => item.kind === 'divider')) return
    const team = await state()
    return team.partsRunning?.[current.sessionId] !== true && current
  }, 'Codex handed off the conversation to another session').catch(async error => {
    const [current, log] = await Promise.all([chat(), host.bot('diagnostics-log')])
    const items = current.items.map(({ kind, text }) => ({ kind, text: text?.slice(0, 200) })).slice(-8)
    const contextLog = log.split('\n').filter(line => /part|Codex|steward|context|compaction/i.test(line)).slice(-12)
    throw new Error(error.message + '\n' + JSON.stringify({ items, contextLog }))
  })
  assert.equal(continued.items.some(item => item.kind === 'user'), false)
  assert.ok(continued.cursor, 'the handoff retained earlier messages in the same conversation')
  assert.ok((await chat(continued.cursor)).items.some(item => item.kind === 'user' && item.text === prompt))
  assert.notEqual((await state()).newSessions?.[bot.id], 'empty', 'the host counts messages before the handoff')

  await host.restart()
  await openFullTeam(host)
  await openBotChat(host, bot)
  const { page } = host
  const button = page.locator('.bt-head .bt-new-session')
  await page.getByText(/^上下文已交接/u).waitFor()
  await until(async () => (await button.getAttribute('data-state')) === 'ready', 'New session stays available after the handoff and restart')
  await button.click()

  const fresh = await until(async () => {
    const current = await chat()
    return current.sessionId !== continued.sessionId && (await state()).newSessions?.[bot.id] === 'empty' && current
  }, 'the button opened a fresh conversation')
  assert.equal(fresh.cursor, null, 'the fresh conversation has its own history')
  assert.equal(await host.bot('bot-new-part', { botId: bot.id }), false, 'an unused conversation still blocks a duplicate')
  assert.ok(!(await state()).emptyParts?.[bot.id]?.includes(first), 'the part with the original messages stays in the switcher')

  assert.equal(await host.bot('bot-open-part', { botId: bot.id, sessionId: first }), true)
  const reopened = await chat()
  assert.equal(reopened.sessionId, first)
  assert.ok(reopened.items.some(item => item.kind === 'user' && item.text === prompt), 'the prior transcript is still readable')
  note('new-session-after-handoff', { previous: first, continued: continued.sessionId, fresh: fresh.sessionId })
}
