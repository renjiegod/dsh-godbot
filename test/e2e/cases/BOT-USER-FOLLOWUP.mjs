import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

export default async function botUserFollowup({ makeHost, candidate, note }) {
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
  const delegated = 'GODBOT-CODEX-EXECUTION-TRACE ' + randomUUID()
  const request = 'Delegate the release check for this fixture.'
  host.model.reply = body => JSON.stringify(body.messages?.at(-1)?.content ?? '').includes(request)
    ? [{ type: 'tool_use', name: 'message_bot', input: { to: worker.name, conversation: worker.id, message: delegated } }]
    : 'Fixture acknowledged.'
  await host.bot('send', { sessionId: sender.id, text: request })
  const [delegatedTurn] = await until(async () => {
    const turns = await hiddenTurns()
    return turns.length && (await state()).partsRunning?.[worker.id] && turns
  }, 'the delegated Codex turn is running')

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
  assert.deepEqual(restored.filter(row => row.kind === 'bot').map(row => row.text), [firstUpdate, secondUpdate])
  assert.equal(restored.find(row => row.kind === 'tool')?.toolId, tool.toolId)
  assert.equal(restored.find(row => row.kind === 'turn-status')?.status, 'stopped')
  assert.deepEqual(await hiddenTurns(), [delegatedTurn], 'opening a phone chat also restores only the user’s turn')
  note('steered-private-bot-chat', { delegatedTurn, followupTurn, webAndPhone: true, legacyMarkerRecovered: true })
}
