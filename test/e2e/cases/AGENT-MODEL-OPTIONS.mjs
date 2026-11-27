import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

// A local agent's model options end to end: the Codex catalog's service tiers reach
// the Bot's details as a Speed control, a pick saves on the Bot, shows as a bolt in
// the header, and reaches the CLI on the next turn; Default hands the thread back to
// the user's own Codex config.
export default async function agentModelOptions({ makeHost, candidate, note }) {
  const host = await makeHost()
  const fixture = new URL('../../external/fixtures/fake-codex.mjs', import.meta.url)
  const requests = join(host.root, 'codex-requests.jsonl')
  await writeFile(join(host.bin, 'codex'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('codex-cli 0.172.0 fixture');
else if (process.argv.includes('status')) console.log('Logged in using ChatGPT');
else {
  process.argv.push('--record', ${JSON.stringify(requests)});
  import(${JSON.stringify(fixture.href)}).catch(error => { console.error(error); process.exitCode = 1; });
}
`, { mode: 0o700 })
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const bot = await host.bot('create-bot', { name: 'Speed tester', model: 'local-codex-cli/gpt-5.1-codex' })
  const chat = () => host.bot('chat', { botId: bot.id })
  const sessionId = await until(async () => {
    const current = await chat()
    return current.items.some(item => item.kind === 'bot') && current.sessionId
  }, 'the Codex Bot greeted the user')
  const turns = async () => (await readFile(requests, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(entry => entry.method === 'turn/start').map(entry => entry.params)

  // The model's catalog offers three speeds; the Bot has no pick yet.
  const { page } = host
  await openBotChat(host, bot)
  await page.locator('[data-gb-bot-model]').click()
  const speed = page.locator('.bt-drawer-model .bt-mo[data-option=speed]')
  await speed.waitFor()
  assert.deepEqual(await speed.getByRole('radio').allInnerTexts(), ['标准', '快速', '超快'])
  assert.equal(await speed.getByRole('radio', { name: '标准' }).getAttribute('aria-checked'), 'true')
  assert.equal(await speed.locator('.bt-mo-tag').innerText(), '默认')
  await host.capture('agent-model-options-default')

  await speed.getByRole('radio', { name: '快速' }).click()
  await until(async () => (await host.bot('state')).bots.find(entry => entry.id === bot.id)?.modelOptions?.speed === 'fast', 'the pick saved on the Bot')
  await speed.getByText('2 倍速度，用量增加').waitFor()
  await page.locator('.gb-bot-model .bt-speed-mark').waitFor()
  await host.capture('agent-model-options-fast')

  const before = (await turns()).length
  await host.bot('send', { sessionId, text: 'Run at the picked speed' })
  const fast = await until(async () => (await turns()).slice(before).find(params => params.input?.some(item => item.text?.includes('Run at the picked speed'))), 'the turn reached Codex')
  assert.equal(fast.serviceTier, 'priority', 'Fast reaches Codex as its priority tier')

  // A value the model does not offer is refused, and the Bot keeps its pick.
  await assert.rejects(host.bot('update-bot', { id: bot.id, modelOptions: { speed: 'warp' } }), /not available/)

  // Default clears the pick: the thread follows the user's Codex config again.
  await speed.locator('.bt-mo-reset').click()
  await until(async () => (await host.bot('state')).bots.find(entry => entry.id === bot.id)?.modelOptions === undefined, 'the pick cleared')
  await until(async () => !(await page.locator('.gb-bot-model .bt-speed-mark').count()), 'the header dropped its bolt')
  await until(async () => (await chat()).items.filter(item => item.kind === 'bot').length >= 2, 'the fast turn finished')
  const middle = (await turns()).length
  await host.bot('send', { sessionId, text: 'Back to my own speed' })
  const standard = await until(async () => (await turns()).slice(middle).find(params => params.input?.some(item => item.text?.includes('Back to my own speed'))), 'the next turn reached Codex')
  assert.equal(standard.serviceTier, null, 'a cleared pick hands the tier back to the Codex config')
  note('agent-model-options', { offered: ['standard', 'fast', 'ultrafast'], fastTier: fast.serviceTier, clearedTier: standard.serviceTier })
}
