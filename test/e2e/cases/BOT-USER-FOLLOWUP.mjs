import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { withAndroidBotChat } from '../android-chat.mjs'

export default async function botUserFollowup(context) {
  const { makeHost, candidate, note } = context
  const host = await makeHost()
  const fixture = new URL('../../external/fixtures/fake-codex.mjs', import.meta.url)
  await writeFile(join(host.bin, 'codex'), `#!/usr/bin/env node
process.env.GODBOT_E2E_GATE_DIR = ${JSON.stringify(host.workspace)}
if (process.argv.includes('--version')) console.log('codex-cli 0.172.0 fixture')
else if (process.argv.includes('status')) console.log('Logged in using ChatGPT')
else await import(${JSON.stringify(fixture.href)})
`, { mode: 0o700 })
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const sender = await host.bot('create-bot', { name: 'Release Requester', model: 'deepseek-official/deepseek-flash' })
  const worker = await host.bot('create-bot', { name: 'Release Assistant', model: 'local-codex-cli/gpt-5.1-codex' })
  const state = () => host.bot('state')
  const chat = bot => host.bot('chat', { botId: bot.id, inlineTools: true, turnStatuses: true })
  for (const bot of [sender, worker]) {
    await until(async () => (await chat(bot)).items.some(row => row.kind === 'bot') &&
      !(await state()).partsRunning?.[bot.id], bot.name + ' finished greeting')
  }
  await openBotChat(host, worker)
  const hiddenTurns = async () => (await state()).exchangeTurns[worker.id] ?? []
  const delegated = 'GODBOT-CODEX-EXECUTION-TRACE ' + randomUUID() + ' GODBOT-DELIVERY-MILESTONE'
  const request = 'Delegate the release check for this fixture.'
  host.model.reply = body => JSON.stringify(body.messages?.at(-1)?.content ?? '').includes(request)
    ? [{ type: 'tool_use', name: 'message_bot', input: { to: worker.name, conversation: worker.id, message: delegated } }]
    : 'Fixture acknowledged.'
  await host.bot('send', { sessionId: sender.id, text: request })
  const [delegatedTurn] = await until(async () => {
    const turns = await hiddenTurns()
    return turns.length && (await state()).partsRunning?.[worker.id] && turns
  }, 'the delegated Codex turn is running')

  const milestone = 'Web checks passed. Android checks are running.'
  const work = await until(async () => {
    const snapshot = await state()
    const work = snapshot.work.delegated?.[worker.id]
    assert.equal(snapshot.work.delegated?.[sender.id], undefined, 'progress belongs to the receiving conversation')
    return work?.progress?.text === milestone && work.count > 0 && work
  }, 'the paired client can read the active request and its explicit milestone')
  assert.equal(work.turn, delegatedTurn)
  assert.ok(work.lastActivityAt >= work.since)
  const progress = host.page.locator('.bt-delegated-progress')
  await progress.getByText(milestone, { exact: true }).waitFor()
  assert.doesNotMatch(await progress.innerText(), /fixture-trace\.txt|Codex fixture progress/u)
  await host.capture('delegated-progress')
  await host.page.locator('.bt-event').filter({ hasText: sender.name }).last().click()
  const exchange = host.page.locator('.bt-exchange .bt-group-msg').filter({ hasText: delegated })
  await exchange.locator('[data-delivery-state="accepted"]').waitFor()
  await exchange.getByText(milestone, { exact: false }).last().waitFor()
  await host.page.locator('.bt-exchange .bt-dialog-foot button').click()
  await withAndroidBotChat(context, host, worker, async ui => {
    await ui.waitFor(nodes => ui.find(nodes, milestone), 'Android shows the live delegated milestone')
    await ui.waitFor(nodes => nodes.find(node => /Last activity|最近活动/u.test(node.text)), 'Android shows observed tool activity')
    await writeFile(join(context.reportDir, 'android-delegated-progress.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Bot message delivery', 'Bot 消息投递'), 'open delivery history'))
    await ui.waitFor(nodes => nodes.find(node => node.text.includes(milestone))
      && ui.find(nodes, 'Engine accepted', '引擎已接收'), 'Android keeps the delivery receipt alongside the milestone')
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Done', '完成'), 'close delivery history'))
    note('android-delegated-progress', { sessionId: worker.id, turn: delegatedTurn })
  })
  const followup = 'GODBOT-CODEX-USER-FOLLOWUP Why so long?'
  await host.bot('send', { sessionId: worker.id, text: followup })
  const { page } = host
  const queued = page.getByText(followup, { exact: true }).filter({ visible: true })
  await queued.waitFor()
  await page.getByRole('button', { name: /Steer queued message|插话发送/u }).click()
  const chatFlow = page.locator('[data-conversation-scroll]')
  const firstUpdate = 'The release verification is still running.'
  const secondUpdate = 'The Web checks passed. I am checking Android.'
  const webProgress = async () => {
    await chatFlow.getByText(firstUpdate, { exact: true }).waitFor()
    await chatFlow.getByText(secondUpdate, { exact: true }).waitFor()
    await chatFlow.locator('.gb-execution-tool').filter({ hasText: 'cat' }).last().waitFor()
  }
  await webProgress()
  const followupRows = async () => {
    const { items } = await chat(worker)
    const turn = items.find(row => row.kind === 'user' && row.text === followup)?.turn
    return items.filter(row => turn !== undefined && row.turn === turn)
  }
  const rows = await until(async () => {
    const items = await followupRows()
    return items.some(row => row.text === secondUpdate) && items
  }, 'the phone sees the user’s follow-up')
  const followupTurn = rows[0].turn
  assert.equal(followupTurn, delegatedTurn + 1)
  assert.deepEqual(await hiddenTurns(), [delegatedTurn])
  const tool = rows.find(row => row.kind === 'tool')
  assert.ok(tool?.toolId)
  assert.equal((await host.bot('chat-tool', { botId: worker.id, sessionId: worker.id, turn: followupTurn, toolId: tool.toolId })).output,
    'Web verified, Android pending.')

  assert.equal(await host.bot('stop-chat', { botId: worker.id, sessionId: worker.id }), true)
  const webStopped = () => chatFlow.locator('[data-outcome="stopped"]').waitFor()
  await webStopped()
  const stopped = await until(async () => (await followupRows()).find(row => row.kind === 'turn-status'), 'the phone sees the same stop')
  assert.equal(stopped.status, 'stopped')
  const savedRows = await followupRows()
  assert.deepEqual(savedRows.map(row => row.kind === 'tool' ? row.name : row.text ?? row.status),
    [followup, firstUpdate, 'Shell', secondUpdate, 'stopped'])
  await webProgress()
  const delivery = (await host.bot('bot-deliveries', { botId: worker.id, sessionId: worker.id })).find(row => row.text === delegated)
  assert.equal(delivery?.state, 'stopped', 'the original request settles under its own delivery')
  assert.equal(delivery.progress.text, milestone)
  assert.equal((await state()).work.delegated?.[worker.id], undefined)

  // Recreate the old host's saved marker, using the same real log and tool
  // receipts. Verify each client's normal entry point repairs it after boot.
  const stateFile = join(host.home, 'godbot', 'web', 'team-workspace', 'state.json')
  const rebootWithLegacyMarker = async () => {
    await openBotChat(host, sender)
    await host.stop()
    const saved = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.deepEqual(saved.exchangeTurns[worker.id], [delegatedTurn])
    saved.exchangeTurns[worker.id].push(followupTurn)
    await writeFile(stateFile, JSON.stringify(saved))
    await host.start()
  }
  await rebootWithLegacyMarker()
  await openFullTeam(host)
  await openBotChat(host, worker)
  await webProgress()
  await webStopped()
  assert.deepEqual(await hiddenTurns(), [delegatedTurn], 'opening the Web chat restores only the user’s turn')
  await rebootWithLegacyMarker()
  const restored = await followupRows()
  const senderHistory = await host.bot('bot-deliveries', { botId: sender.id, sessionId: sender.id })
  assert.equal(senderHistory.find(row => row.id === delivery.id)?.progress.text, milestone)
  assert.deepEqual(restored.filter(row => row.kind === 'bot').map(row => row.text), [firstUpdate, secondUpdate])
  assert.equal(restored.find(row => row.kind === 'tool')?.toolId, tool.toolId)
  assert.equal(restored.find(row => row.kind === 'turn-status')?.status, 'stopped')
  assert.deepEqual(await hiddenTurns(), [delegatedTurn], 'opening a phone chat also restores only the user’s turn')
  note('steered-private-bot-chat', { delegatedTurn, followupTurn, webAndPhone: true, legacyMarkerRecovered: true })
}
