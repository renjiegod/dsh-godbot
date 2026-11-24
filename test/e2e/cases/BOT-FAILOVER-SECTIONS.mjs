import assert from 'node:assert/strict'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

const flash = 'deepseek-official/deepseek-flash'
const pro = 'deepseek-official/deepseek-v4-pro'
const expected = text => body => JSON.stringify(body).includes(text)
const latestTask = (body, text) => {
  const message = body.messages?.findLast(item => item.role === 'user' && JSON.stringify(item).includes(text))
  return !!message && !body.messages.slice(body.messages.indexOf(message) + 1).some(item => item.role === 'assistant')
}
const session = bot => bot.sessionId ?? bot.id
const roomIdentity = body => {
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map(block => block.text).join('\n')
  return /<identity>\s*You are ([^,\r\n]+), a Bot/u.exec(system)?.[1]
}

function replyFor(host, bot, text, timeout) {
  return until(async () => {
    const { items } = await host.bot('chat', { botId: bot.id })
    const user = items.find(item => item.kind === 'user' && item.text === text)
    const reply = user && items.find(item => item.kind === 'bot' && item.turn === user.turn)
    if (!reply) return undefined
    const state = await host.bot('state')
    return state.partsRunning?.[session(bot)] !== true ? reply : undefined
  }, `${bot.name} replied to ${text}`, timeout)
}

export default async function verify({ makeHost, candidate, note }) {
  const host = await makeHost()
  host.model.models = ['deepseek-flash', 'deepseek-v4-pro']
  const fixture = new URL('../../external/fixtures/fake-codex.mjs', import.meta.url).href
  await writeFile(join(host.bin, 'codex'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('codex-cli 1.0.0');
else if (process.argv.includes('status')) console.log('Logged in using ChatGPT');
else import(${JSON.stringify(fixture)});
`, { mode: 0o700 })
  const credential = join(host.root, 'fixture-claude-signed-in')
  const claude = new URL('../../external/fixtures/fake-claude-signed-out.mjs', import.meta.url).href
  await writeFile(credential, 'fixture session')
  await writeFile(join(host.bin, 'claude'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)');
else if (process.argv.includes('status')) console.log(JSON.stringify({ loggedIn: true }));
else {
  process.env.FAKE_SIGNED_IN = ${JSON.stringify(credential)};
  import(${JSON.stringify(claude)});
}
`, { mode: 0o700 })
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const state = () => host.bot('state')
  const call = (endpoint, body) => host.bot(endpoint, body)
  const primary = await call('create-bot', { name: 'Primary', model: flash })
  const backup = await call('create-bot', { name: 'Backup', model: pro })
  const outsider = await call('create-bot', { name: 'Outsider', model: pro })
  const botView = async bot => (await state()).bots.find(entry => entry.id === bot.id)
  const send = (bot, text) => call('send', { sessionId: session(bot), text })
  const section = await call('section-save', { name: 'Delivery', items: [primary.id, backup.id] })
  const { page } = host
  const sectionBox = page.locator(`[data-sec-id="${section.id}"] .bt-sec-head-wrap`)
  await sectionBox.hover()
  await sectionBox.locator('button.bt-sec-act').last().click()
  await page.getByRole('menuitem', { name: '分组简介与记忆' }).click()
  const editor = page.locator('[data-godbot-section-context]')
  await editor.getByLabel('分组简介', { exact: true }).fill('SECTION-MISSION-ONLY')
  await editor.getByRole('button', { name: '保存简介' }).click()
  await editor.getByRole('button', { name: '添加', exact: true }).click()
  await editor.locator('form textarea').fill('DELIVERY-MEMORY-ONE')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await editor.locator('.gb-section-entries').getByText('DELIVERY-MEMORY-ONE', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal((await state()).sections.find(row => row.id === section.id).description, 'SECTION-MISSION-ONLY')
  assert.equal((await call('memory-view', { sectionId: section.id })).entries[0].text, 'DELIVERY-MEMORY-ONE')
  assert.equal((await call('memory-view', { botId: primary.id })).entries.some(entry => entry.text === 'DELIVERY-MEMORY-ONE'), false)
  for (const bot of [primary, backup, outsider]) {
    const marker = 'check-original-scope-' + bot.name
    await send(bot, marker)
    await replyFor(host, bot, marker)
    const seen = host.model.calls.find(row => row.sessionId === session(bot) && expected(marker)(row.body))
    assert.ok(seen)
    assert.equal(expected('SECTION-MISSION-ONLY')(seen.body), bot !== outsider, bot.name)
    assert.equal(expected('DELIVERY-MEMORY-ONE')(seen.body), bot !== outsider, bot.name)
  }
  host.model.reply = body => latestTask(body, 'SECTION-WRITE-FROM-BOT')
    ? [{ type: 'tool_use', name: 'remember', input: { scope: 'section', text: 'DELIVERY-MEMORY-FROM-BOT' } }]
    : 'Fixture acknowledged the request.'
  await send(primary, 'SECTION-WRITE-FROM-BOT')
  await replyFor(host, primary, 'SECTION-WRITE-FROM-BOT')
  assert.ok((await call('memory-view', { sectionId: section.id })).entries.some(entry => entry.text === 'DELIVERY-MEMORY-FROM-BOT'))
  await send(backup, 'check-shared-write')
  await replyFor(host, backup, 'check-shared-write')
  const sharedWrite = host.model.calls.find(row => row.sessionId === session(backup) && expected('check-shared-write')(row.body))
  assert.ok(sharedWrite && expected('DELIVERY-MEMORY-FROM-BOT')(sharedWrite.body))
  await call('set-flags', { id: backup.id, sectionId: null })
  await send(backup, 'check-moved-out')
  await replyFor(host, backup, 'check-moved-out')
  const moved = host.model.calls.find(row => row.sessionId === session(backup) && expected('check-moved-out')(row.body))
  assert.ok(moved)
  assert.equal(expected('SECTION-MISSION-ONLY')(moved.body), false)
  assert.equal(expected('DELIVERY-MEMORY-ONE')(moved.body), false)
  await call('memory-edit', { sectionId: section.id, text: 'DELIVERY-MEMORY-ONE', next: 'DELIVERY-MEMORY-TWO' })
  await send(primary, 'check-edited-memory')
  await replyFor(host, primary, 'check-edited-memory')
  const changed = host.model.calls.find(row => row.sessionId === session(primary) && expected('check-edited-memory')(row.body))
  assert.ok(expected('DELIVERY-MEMORY-TWO')(changed.body))
  assert.equal(expected('DELIVERY-MEMORY-ONE')(changed.body), false)
  note('section-memory-isolation', { browserEditor: true, sharedBotWrite: true, sameSection: 2, outsideSection: 1, removedMembership: true, updatedNextTurn: true })

  const policy = { triggers: ['timeout', 'network', 'authentication'], agents: [pro], bots: [backup.id], timeoutSeconds: 1 }
  await openBotChat(host, primary)
  await page.locator('.bt-head .bt-pill-name').click()
  await page.locator('[data-info-row="settings"]').click()
  await page.getByRole('button', { name: '配置故障转移' }).click()
  const failoverEditor = page.locator('[data-godbot-failover-form]')
  await failoverEditor.getByRole('checkbox', { name: '限流或额度不足' }).uncheck()
  await failoverEditor.getByRole('checkbox', { name: 'Agent 不可用' }).uncheck()
  await failoverEditor.getByRole('spinbutton', { name: 'Agent 调用超时（秒）' }).fill('1')
  await failoverEditor.getByRole('combobox', { name: '备用 Agent（按顺序）' }).selectOption(pro)
  await failoverEditor.getByRole('combobox', { name: '接手 Bot（按顺序）' }).selectOption(backup.id)
  await failoverEditor.getByRole('button', { name: '保存', exact: true }).click()
  await failoverEditor.waitFor({ state: 'hidden' })
  await assert.rejects(call('update-bot', { id: primary.id, failover: { ...policy, bots: [primary.id] } }), /available|backup/i)
  assert.deepEqual((await botView(primary)).failover, policy)
  await host.restart()
  await openFullTeam(host)
  assert.deepEqual((await botView(primary)).failover, policy)
  assert.equal((await state()).sections.find(row => row.id === section.id).description, 'SECTION-MISSION-ONLY')
  assert.ok((await call('memory-view', { sectionId: section.id })).entries.some(entry => entry.text === 'DELIVERY-MEMORY-TWO'))

  host.model.reply = async (body, request) => {
    const source = request.sessionId === session(primary)
    if (source && latestTask(body, 'AUTH-FAILOVER') && body.model === 'deepseek-flash')
      return { failure: { status: 401, message: 'expired credentials' } }
    if (source && latestTask(body, 'DEADLINE-FAILOVER') && body.model === 'deepseek-flash') {
      await wait(3500)
      return 'Late primary must not replace the backup reply.'
    }
    if (source && latestTask(body, 'BOT-HANDOFF')) return { failure: { status: 503, message: 'service unavailable' } }
    if (latestTask(body, 'ROOM-BACKUP')) {
      const identity = roomIdentity(body)
      if (identity === 'Outsider') return 'Room task recovered.'
      if (identity === 'Primary' || identity === 'Backup') return { failure: { status: 401, message: 'expired credentials' } }
    }
    if (latestTask(body, 'NATIVE-FAILOVER') && source && body.model === 'deepseek-flash')
      return { failure: { status: 401, message: 'expired credentials' } }
    return 'Completed by ' + body.model
  }
  for (const [message, trigger] of [['AUTH-FAILOVER', 'authentication'], ['DEADLINE-FAILOVER', 'timeout']]) {
    const before = host.model.calls.length
    await send(primary, message)
    const result = await replyFor(host, primary, message)
    assert.equal(result.text, 'Completed by deepseek-v4-pro')
    const seen = host.model.calls.slice(before).filter(row => row.sessionId === session(primary) && expected(message)(row.body))
    assert.deepEqual(seen.map(row => row.body.model), ['deepseek-flash', 'deepseek-v4-pro'])
    const recent = await until(async () => (await botView(primary)).failoverHistory?.find(row => row.trigger === trigger && row.target === pro), trigger)
    assert.equal(recent.status, 'switched')
    assert.equal((await botView(primary)).model, flash)
  }
  const native = (await state()).models.find(model => model.ref.startsWith('local-codex-cli/'))
  assert.ok(native, 'the fixture Codex is registered')
  await call('update-bot', { id: primary.id, failover: { ...policy, agents: [native.ref], timeoutSeconds: 10 } })
  await send(primary, 'NATIVE-FAILOVER show-thread')
  const nativeReply = await replyFor(host, primary, 'NATIVE-FAILOVER show-thread')
  assert.match(nativeReply.text, /DELIVERY-MEMORY-TWO/, 'the native fallback reads the current section context')
  const nativeSwitch = await until(async () => (await botView(primary)).failoverHistory?.find(row => row.target === native.ref), 'the same Bot switched to a local CLI')
  assert.equal(nativeSwitch.status, 'switched')
  assert.equal((await botView(primary)).model, flash)
  await call('update-bot', { id: primary.id, failover: policy })

  await send(primary, 'BOT-HANDOFF')
  const handoff = await until(async () => (await botView(primary)).failoverHistory?.find(row => row.kind === 'bot' && row.status === 'completed'), 'a completed automatic handoff')
  assert.equal(handoff.targetBotId, backup.id)
  assert.notEqual(handoff.targetSessionId, session(backup))
  assert.equal((await botView(backup)).sessionId, session(backup))
  assert.ok(host.model.calls.some(row => row.sessionId === handoff.targetSessionId && expected('BOT-HANDOFF')(row.body)))
  assert.equal(host.model.calls.some(row => row.sessionId === session(backup) && expected('BOT-HANDOFF')(row.body)), false)
  const room = await call('create-room', { name: 'Delivery room', members: [primary.id, backup.id, outsider.id], admin: primary.id })
  await call('update-bot', { id: primary.id, failover: { ...policy, agents: [], bots: [backup.id, outsider.id], timeoutSeconds: 10 } })
  await call('send', { sessionId: room.id, text: '@Primary ROOM-BACKUP' })
  const roomHandoff = await until(async () => (await botView(primary)).failoverHistory?.find(row =>
    row.roomId === room.id && ['completed', 'failed', 'exhausted'].includes(row.status)), 'the backup Bots settle the task in the group chat', 45_000)
    .catch(async error => {
      note('room-handoff-diagnostics', {
        history: (await botView(primary)).failoverHistory,
        items: (await call('room-chat', { roomId: room.id })).items.map(({ kind, botId, event, text }) => ({ kind, botId, event, text })),
        routes: host.model.calls.filter(row => expected('ROOM-BACKUP')(row.body)).map(row => ({ sessionId: row.sessionId, model: row.body.model,
          identity: roomIdentity(row.body) ?? null })),
      })
      throw error
    })
  assert.equal(roomHandoff.status, 'completed', JSON.stringify(roomHandoff))
  assert.equal(roomHandoff.targetBotId, outsider.id)
  const roomCalls = host.model.calls.filter(row => latestTask(row.body, 'ROOM-BACKUP'))
  assert.deepEqual([...new Set(roomCalls.map(row => roomIdentity(row.body)).filter(Boolean))], ['Primary', 'Backup', 'Outsider'])
  const roomRequest = host.model.calls.find(row => row.sessionId === roomHandoff.targetSessionId && expected('ROOM-BACKUP')(row.body))
  assert.ok(roomRequest)
  assert.equal(expected('Your own chat with the user so far')(roomRequest.body), false)
  await until(async () => (await call('room-chat', { roomId: room.id })).items.find(item =>
    item.kind === 'bot' && item.botId === outsider.id && item.text === 'Room task recovered.'), 'the recovered reply is posted to the original group chat')
  note('room-handoff', { triedConfiguredOrder: true, returnedToRoom: true })

  const claudeModel = (await state()).models.find(model => model.ref.startsWith('local-claude-code/'))
  assert.ok(claudeModel)
  const nativePrimary = await call('create-bot', { name: 'Native Primary', model: claudeModel.ref })
  await send(nativePrimary, 'NATIVE-PRIMARY-WARMUP')
  assert.match((await replyFor(host, nativePrimary, 'NATIVE-PRIMARY-WARMUP')).text, /^reply:/)
  await call('update-bot', { id: nativePrimary.id, failover: { triggers: ['authentication'], agents: [pro], bots: [], timeoutSeconds: null } })
  await unlink(credential)
  await send(nativePrimary, 'NATIVE-PRIMARY-EXPIRED')
  try {
    assert.equal((await replyFor(host, nativePrimary, 'NATIVE-PRIMARY-EXPIRED')).text, 'Completed by deepseek-v4-pro')
  } catch (error) {
    const bot = await botView(nativePrimary)
    const chat = await call('chat', { botId: nativePrimary.id })
    note('native-primary-result', {
      blocked: bot.blocked ?? null, failures: bot.failures ?? null, history: bot.failoverHistory ?? [],
      recent: chat.items.slice(-5).map(item => ({ kind: item.kind, text: item.text?.slice(0, 220), failure: item.failure })),
      cloud: host.model.calls.filter(row => row.sessionId === session(nativePrimary)).map(row => row.body.model),
    })
    throw error
  }
  await writeFile(credential, 'fixture session')
  await send(nativePrimary, 'NATIVE-PRIMARY-RESTORED')
  assert.match((await replyFor(host, nativePrimary, 'NATIVE-PRIMARY-RESTORED')).text, /^reply:/)
  note('failover-policies', { providerAuth: true, deadline: true, nativeFallback: native.ref, nativeCredentialsExpiredAndRestored: true, backupBot: handoff.targetBotId, sessionPreserved: true, separateHandoffConversation: true, restored: true })
}
