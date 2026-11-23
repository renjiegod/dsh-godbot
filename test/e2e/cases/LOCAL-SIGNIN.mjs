import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { openProviderSettingsFromTeam } from '../provider-settings.mjs'
import { member } from '../tickets.mjs'

// A local agent CLI whose sign-in expired is signed in again from Godbot's page.
// Claude Code: the Bot's setup turn fails with the CLI's "Failed to authenticate",
// which must be the turn's failure (a repair card with Sign in), never the Bot's
// reply. The card's sign-in runs `claude auth login`, takes the code the user pastes,
// and once the CLI is signed in the Bot is unblocked and its greeting goes out.
// When the sign-in expires later in the conversation, the user's message fails the
// same way; once signed in from the card, the Bot answers it without a Retry click.
// Codex: Settings → Local agents signs it in with the device code `codex login
// --device-auth` prints. Gemini CLI: its own sign-in screen runs in a terminal on
// the page, and the sign-in ends once the CLI's check finds its credential.
const fixture = name => JSON.stringify(new URL('../../external/fixtures/' + name, import.meta.url).href)

export default async function LOCAL_SIGNIN(context) {
  const host = await context.makeHost()
  const claudeFlag = join(host.root, 'claude-signed-in')
  const codexFlag = join(host.root, 'codex-signed-in')
  await writeFile(join(host.bin, 'claude'), `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const flag = ${JSON.stringify(claudeFlag)};
process.env.FAKE_SIGNED_IN = flag;
const args = process.argv.slice(2);
const run = file => import(file).catch(e => { console.error(e); process.exit(1); });
if (args.includes('--version')) console.log('2.1.0 fixture');
else if (args[0] === 'auth' && args[1] === 'status') console.log(JSON.stringify({ loggedIn: existsSync(flag) }));
else if (args[0] === 'auth' && args[1] === 'login') run(${fixture('fake-claude-login.mjs')});
else run(${fixture('fake-claude-signed-out.mjs')});
`, { mode: 0o700 })
  await writeFile(join(host.bin, 'codex'), `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const flag = ${JSON.stringify(codexFlag)};
process.env.FAKE_SIGNED_IN = flag;
process.env.FAKE_DEVICE_DELAY = '2500';
const args = process.argv.slice(2);
const run = file => import(file).catch(e => { console.error(e); process.exit(1); });
if (args.includes('--version')) console.log('codex-cli 0.171.0 fixture');
else if (args[0] === 'login' && args[1] === 'status') { if (existsSync(flag)) console.log('Logged in using ChatGPT'); else { console.error('Not logged in'); process.exitCode = 1; } }
else if (args[0] === 'login') run(${fixture('fake-codex-login.mjs')});
else run(${fixture('fake-codex.mjs')});
`, { mode: 0o700 })
  await writeFile(join(host.bin, 'gemini'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('0.30.0 fixture');
else import(${fixture('fake-gemini-login.mjs')}).catch(e => { console.error(e); process.exit(1); });
`, { mode: 0o700 })
  await host.install(context.candidate)
  await host.start()
  await openFullTeam(host)
  // Phones learn of the sign-in endpoints from the handshake.
  assert.ok((await host.bot('hello', { api: [1] })).capabilities.includes('local-agent-login'), 'hello names local-agent-login')

  // Claude Code: the expired sign-in blocks the Bot with a repair card, not a reply.
  const bot = await member(host, 'Signed-out Claude', 'local-claude-code/default')
  const blocked = await until(async () => (await host.bot('state')).bots.find(row => row.id === bot.id)?.blocked, bot.name + ' blocked by its sign-in')
  assert.equal(blocked.code, 'LOCAL_AGENT_SIGNIN')
  assert.equal(blocked.provider, 'local-claude-code')
  const items = async () => (await host.bot('chat', { botId: bot.id })).items ?? []
  assert.ok(!(await items()).some(item => item.kind === 'bot' && /Failed to authenticate/u.test(item.text ?? '')), 'the CLI\'s error is not the Bot\'s reply')

  const { page } = host
  await page.locator('.bt-row[data-bot-id="' + bot.id + '"]').click()
  const card = page.locator('.bt-fail').filter({ has: page.locator('[data-fix="local-sign-in"]') }).last()
  await card.waitFor()
  assert.equal(await card.locator('[data-fix="retry"]').count(), 0, 'Retry waits for the sign-in')
  await card.locator('[data-fix="local-sign-in"]').click()
  const panel = card.locator('[data-local-sign-in="local-claude-code"]')
  // The page runs on the host's computer: it opens the CLI's loopback link, and
  // still takes a pasted code.
  const link = panel.locator('[data-signin-link="auto"]')
  await link.waitFor()
  assert.match(await link.getAttribute('href'), /redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2Fcallback/u)
  await card.screenshot({ path: join(host.reportDir, 'claude-sign-in-card.png') })
  await panel.locator('input').fill('e2e-code#s1')
  await panel.locator('button[type="submit"]').click()
  await until(async () => (await host.bot('state')).bots.find(row => row.id === bot.id)?.blocked === undefined, bot.name + ' unblocked by the sign-in')
  // The held greeting goes out again, now answered by the signed-in CLI, and the
  // card settles: the turn it was about has been moved past.
  await until(async () => (await items()).some(item => item.kind === 'bot' && /^reply: /u.test(item.text ?? '')), bot.name + ' answers once signed in', 40_000)
  await until(async () => await page.locator('.bt-fail [data-fix="local-sign-in"]').count() === 0, 'the repair card settles once the Bot answered')

  // The sign-in expires in the middle of the conversation: the user's message fails,
  // and signing in from its card answers it, with no Retry.
  await rm(claudeFlag, { force: true })
  const replies = async () => (await items()).filter(item => item.kind === 'bot' && /^reply: /u.test(item.text ?? '')).length
  const before = await replies()
  await host.bot('send', { sessionId: bot.id, text: 'Are you still there?' })
  await until(async () => (await host.bot('state')).bots.find(row => row.id === bot.id)?.blocked?.code === 'LOCAL_AGENT_SIGNIN', bot.name + ' blocked again')
  const again = page.locator('.bt-fail').filter({ has: page.locator('[data-fix="local-sign-in"]') }).last()
  await again.waitFor()
  await again.locator('[data-fix="local-sign-in"]').click()
  const panelAgain = again.locator('[data-local-sign-in="local-claude-code"]')
  await panelAgain.locator('input').fill('e2e-code#s2')
  await panelAgain.locator('button[type="submit"]').click()
  await until(async () => await replies() === before + 1, bot.name + ' answers the failed message on its own after the sign-in', 40_000)
  await new Promise(resolve => setTimeout(resolve, 3_000))
  assert.equal(await replies(), before + 1, 'the Bot answers once')

  // Codex: Settings → Local agents → Codex CLI → the host account's Sign in.
  const view = await openProviderSettingsFromTeam(host)
  await view.locator('[data-provider-route="local-codex-cli"]').click()
  const detail = view.locator('[data-provider-detail="local-codex-cli"]')
  await detail.waitFor()
  await detail.locator('[data-account-id="local"] [data-account-action="login"]').click()
  const codex = detail.locator('[data-local-sign-in="local-codex-cli"]')
  assert.equal(await codex.locator('[data-signin-code]').textContent({ timeout: 20_000 }), 'WXYZ-12345')
  assert.equal(await codex.locator('a.bt-signin-go').getAttribute('href'), 'https://auth.openai.com/codex/device')
  await codex.screenshot({ path: join(host.reportDir, 'codex-device-code.png') })
  await codex.locator('[data-signin-done]').waitFor({ timeout: 20_000 })

  // Gemini CLI: Settings → Local agents → Gemini CLI → Sign in opens its screen in
  // a terminal on the page; the code typed there signs it in.
  await view.getByRole('button', { name: '返回提供商列表' }).click()
  await view.locator('[data-provider-route="local-gemini-cli"]').click()
  const gemini = view.locator('[data-provider-detail="local-gemini-cli"]')
  await gemini.waitFor()
  await gemini.locator('[data-agent-action="sign-in"]').click()
  const screen = gemini.locator('[data-local-sign-in="local-gemini-cli"] .bt-signin-term')
  await screen.waitFor()
  await until(async () => /Enter the authorization code/u.test(await screen.evaluate(node => node.shadowRoot?.textContent ?? '')), 'the CLI\'s sign-in screen on the page')
  await screen.click()
  await page.keyboard.type('fixture-code')
  await gemini.locator('[data-local-sign-in="local-gemini-cli"]').screenshot({ path: join(host.reportDir, 'gemini-terminal.png') })
  await page.keyboard.press('Enter')
  await gemini.locator('[data-local-sign-in="local-gemini-cli"] [data-signin-done]').waitFor({ timeout: 20_000 })
}
