import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { member } from '../tickets.mjs'
import { startRelay } from '../phone-relay.mjs'

async function checkAndroid(context, host, bot) {
  const app = process.env.GODBOT_ANDROID_E2E
  const apk = process.env.GODBOT_E2E_APK
  if (!app || !apk) return
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  assert.equal(ui.shell('getprop ro.kernel.qemu').trim(), '1', 'use a disposable emulator')
  const relay = await startRelay(context.scratch, context.note)
  const port = new URL(relay.url).port
  let forwarded = false
  const phone = async (endpoint, payload = null) => {
    const response = await host.page.context().request.post(host.url + '/api/godbot/team', {
      data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15_000,
    })
    const result = await response.json()
    assert.ok(response.ok() && result.ok, endpoint)
    return result.value
  }
  try {
    await phone('phone-set', { server: relay.url, on: true })
    await until(async () => (await phone('phone-set', {})).status === 'online', 'DSH connected to the Android test relay')
    const { pairing } = await phone('phone-pair')
    ui.install(apk)
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    forwarded = true
    ui.openUrl(pairing.uri)
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Pair', '配对'), 'pair the test APK'))
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Open team list', '打开团队列表'), 'open Android sidebar'))
    ui.tap(await ui.waitFor(nodes => nodes.find(node => node.text === bot.name && node.bounds.x1 < 700)
      ?? nodes.find(node => node.clickable && node.desc.startsWith(bot.name + ',')), 'open the Claude chat on Android'))
    const status = async (en, zh) => ui.waitFor(nodes => ui.find(nodes, en, zh), en)
    await status('Turn stopped', '回合已停止')
    const prompt = 'OUTCOME-LATE Android check'
    await host.bot('send', { sessionId: bot.id, text: prompt })
    await ui.waitFor(nodes => {
      const sent = ui.find(nodes, prompt)
      return sent && nodes.find(node => node.bounds.y1 > sent.bounds.y1 &&
        ['Turn interrupted', '回合已中断'].some(label => node.text === label || node.desc === label))
    }, 'the new Android turn shows interrupted')
    await writeFile(join(context.reportDir, 'android-turn-interrupted.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    context.note('android-turn-outcomes', { stopped: true, interrupted: true })
  } finally {
    if (forwarded) ui.adb(['reverse', '--remove', 'tcp:' + port])
    await relay.close()
  }
}

export default async function turnOutcomes(context) {
  const { makeHost, candidate, note } = context
  const host = await makeHost()
  const fixture = new URL('../../external/fixtures/fake-claude-turns.mjs', import.meta.url)
  await writeFile(join(host.bin, 'claude'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('2.1.331 fixture');
else if (process.argv.includes('status')) console.log(JSON.stringify({ loggedIn: true }));
else await import(${JSON.stringify(fixture.href)});
`, { mode: 0o700 })
  await host.install(candidate)
  await host.start()
  await host.bot('set-prefs', { layout: 'conversation' })
  await openFullTeam(host)
  const bot = await member(host, 'Claude Turn Outcomes', 'local-claude-code/default')
  const read = async () => (await host.bot('chat', { botId: bot.id, inlineTools: true, turnStatuses: true })).items
  const rows = async prompt => {
    const items = await read()
    const turn = items.find(item => item.kind === 'user' && item.text === prompt)?.turn
    return Number.isInteger(turn) ? items.filter(item => item.turn === turn) : []
  }
  await until(async () => (await read()).some(row => row.kind === 'bot'), 'Claude setup greeting')
  await openBotChat(host, bot)
  const { page } = host
  const interrupted = page.locator('.gb-turn-outcome[data-outcome="interrupted"]')
  const stopped = page.locator('.gb-turn-outcome[data-outcome="stopped"]')
  const completion = page.locator('.gb-turn-duration')
  const initialCompletions = await completion.count()
  await host.bot('send', { sessionId: bot.id, text: 'OUTCOME-LATE' })
  await interrupted.waitFor({ state: 'visible' })
  assert.equal(await completion.count(), initialCompletions)
  const failed = await until(async () => {
    const current = await rows('OUTCOME-LATE')
    return current.find(row => row.kind === 'tool' && row.status === 'failed') && current
  }, 'late tool result updates its original phone chat row')
  assert.equal(failed.at(-1).status, 'interrupted')
  assert.equal(failed.at(-1).code, 'LOCAL_AGENT_INTERRUPTED')
  const log = await host.bot('diagnostics-log')
  const boundary = log.split('\n').find(line => line.includes('cause="tool-result-missing"'))
  const receipt = log.split('\n').find(line => line.includes('late=true') && line.includes('exitCode=137'))
  const correlation = fields => fields.match(/(?:nativeSessionId|nativeTurnId|toolId)="[^"]+"/gu)
  assert.ok(boundary && receipt)
  assert.equal(correlation(boundary)?.length, 3)
  assert.deepEqual(correlation(boundary), correlation(receipt))
  assert.match(boundary, /requestedTimeoutMs=900000/u)
  assert.doesNotMatch(log, /fixture-private-command|fixture-private-output/u)
  const work = page.locator('.gb-turn-attempt')
  await work.locator('summary').click()
  await work.getByText('Started the fixture command.', { exact: true }).waitFor()
  await host.capture('turn-interrupted')

  await host.bot('send', { sessionId: bot.id, text: 'OUTCOME-RECOVERED' })
  await page.getByText('Claude handled the tool failure.', { exact: true }).waitFor({ state: 'visible' })
  await until(async () => await completion.count() === initialCompletions + 1, 'an agent that handled a tool error completed normally')
  assert.equal(await interrupted.count(), 1)
  assert.ok(!(await rows('OUTCOME-RECOVERED')).some(row => row.kind === 'turn-status'))

  await host.bot('send', { sessionId: bot.id, text: 'OUTCOME-HOLD' })
  await until(async () => (await rows('OUTCOME-HOLD')).some(row => row.kind === 'tool' && row.status === 'running'), 'the Claude command is live')
  assert.equal(await host.bot('stop-chat', { botId: bot.id }), true)
  await stopped.waitFor({ state: 'visible' })
  await until(async () => (await rows('OUTCOME-HOLD')).some(row => row.kind === 'turn-status' && row.status === 'stopped'), 'the phone sees the same manual stop')
  assert.equal(await completion.count(), initialCompletions + 1)
  await page.reload()
  await openBotChat(host, bot)
  await interrupted.waitFor({ state: 'visible' })
  await stopped.waitFor({ state: 'visible' })
  await checkAndroid(context, host, bot)
  note('persisted-turn-outcomes', { interrupted: true, recovered: true, stopped: true, lateExitCode: 137, webAndMobile: true })
}
