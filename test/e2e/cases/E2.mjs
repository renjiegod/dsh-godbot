import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { member, ticketEnvironment, replyOf, sendTicket, verifyMemberRead } from '../tickets.mjs'
import { names } from '../fixtures/ticket-client.mjs'

export default async function E2(context) {
  const { host, tickets } = await ticketEnvironment(context, { approval: true })
  try {
    const bot = await member(host, 'Writer Claude', 'local-claude-code/default')
    const choose = async choice => {
      const card = await until(async () => (await host.bot('state')).work.approvals
        .find(item => item.botId === bot.id && item.tool === names.write && item.answerable), bot.name + ' write approval')
      await host.bot('approval-answer', { id: card.id, choice })
      return card.id
    }
    for (const choice of ['reject', 'allow']) {
      const marker = await sendTicket(host, bot, 'write')
      const id = await choose(choice)
      await replyOf(host, bot, marker, choice === 'allow' ? 'VALUE' : 'DENIED')
      const count = tickets.calls.filter(call => call.input.query.id === marker).length
      assert.equal(count, choice === 'allow' ? 1 : 0)
      context.note('approval', { choice, id, marker, upstreamCalls: count })
    }

    await host.bot('connector-set', { id: 'tickets', readOnly: true })
    const readonly = await sendTicket(host, bot, 'write')
    await choose('allow')
    await replyOf(host, bot, readonly, 'DENIED')
    assert.equal(tickets.calls.filter(call => call.input.query.id === readonly).length, 0)
    const held = await sendTicket(host, bot, 'hold')
    await until(() => access(join(host.workspace, held + '.listed')).then(() => true, () => false), 'CLI received the pre-revocation catalog')
    await host.bot('connector-set', { id: 'tickets', offFor: [bot.id] })
    await writeFile(join(host.workspace, held + '.resume'), 'release')
    await replyOf(host, bot, held, 'DENIED')
    assert.equal(tickets.calls.filter(call => call.input.query.id === held).length, 0)
    await host.restart()
    await openFullTeam(host)
    const stillOff = await sendTicket(host, bot, 'list')
    assert.ok((await replyOf(host, bot, stillOff, 'LIST')).includes(stillOff + ' disabled'))
    await host.bot('connector-set', { id: 'tickets', offFor: [], readOnly: true })
    await verifyMemberRead(host, bot, tickets, context.note)

    const target = { botId: bot.id, sessionId: bot.sessionId, agent: 'local-claude-code' }
    const { page } = host
    await page.locator('.bt-row-title').filter({ hasText: bot.name }).click()
    await page.locator('.bt-head .bt-pill-name').filter({ hasText: bot.name }).waitFor()
    const openAgent = page.locator('.bt-head').getByRole('button', { name: '原生 Agent', exact: true })
    await openAgent.click()
    await page.getByRole('menuitem', { name: '原生终端', exact: true }).waitFor()
    assert.equal((await host.rpc('godbot/terminalStatus', { request: target })).active, false)
    await page.getByRole('menuitem', { name: '原生对话', exact: true }).click()
    const panel = page.locator('.gb-terminal-panel[data-phase="live"]')
    await panel.waitFor()
    const receiptPath = join(host.root, 'claude-terminal.json')
    const accepted = await until(async () => {
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      return receipt.accepted && receipt
    }, 'Claude process accepted the folder after the owner opened native conversation', 12_000)
    assert.deepEqual(accepted.keys, ['down', 'return'])
    // Read the Host lease only after the child's receipt, so this RPC cannot start acceptance.
    const terminal = await host.rpc('godbot/terminalOpen', { request: target })
    const terminalId = terminal.terminalId
    assert.ok(terminalId && terminal.reused)
    assert.equal(accepted.cwd, terminal.cwd)
    assert.equal(accepted.nativeId, terminal.nativeId)
    const history = await host.rpc('godbot/dispatch', { request: { action: 'terminal.history', terminalId } })
    assert.ok(history.messages.some(item => item.role === 'assistant' && item.text.includes(readonly)))
    await panel.locator('.gb-native-history').getByText(readonly, { exact: false }).first().waitFor()
    const nativeOutput = panel.locator('[data-native-output]')
    const composer = panel.getByRole('textbox', { name: '原生对话输入' })
    await composer.fill('from-conversation')
    await composer.press('Enter')
    await nativeOutput.getByText('Fixture reply: from-conversation', { exact: false }).first().waitFor()
    await panel.locator('.xterm').evaluate(node => { node.dataset.e2eContinuity = 'same-view' })
    await panel.getByRole('button', { name: '原生终端', exact: true }).click()
    const keyboard = panel.locator('.xterm-helper-textarea')
    assert.ok(await keyboard.evaluate(node => node.getRootNode().activeElement === node), 'the terminal takes keyboard focus on switch')
    await keyboard.pressSequentially('from-terminal')
    await keyboard.press('Enter')
    await panel.getByRole('button', { name: '原生对话', exact: true }).click()
    await nativeOutput.filter({ hasText: 'Fixture reply: from-terminal' }).waitFor()
    assert.equal(await panel.locator('.xterm').getAttribute('data-e2e-continuity'), 'same-view')
    await host.capture('bot-native-conversation')

    await panel.getByRole('button', { name: '收起原生 Agent' }).click()
    await panel.waitFor({ state: 'hidden' })
    assert.equal((await host.rpc('godbot/terminalStatus', { request: target })).active, true)
    await openAgent.click()
    await page.route('**/api/godbot/terminalOpen', route => route.abort(), { times: 1 })
    await page.getByRole('menuitem', { name: '原生终端' }).click()
    await page.locator('.gb-terminal-panel').getByRole('button', { name: '重新连接' }).click()
    await panel.waitFor()
    const reopened = await host.rpc('godbot/terminalOpen', { request: target })
    assert.equal(reopened.terminalId, terminalId)
    assert.equal(reopened.nativeId, terminal.nativeId)
    await panel.getByRole('button', { name: '收起原生 Agent' }).click()
    const queued = await sendTicket(host, bot, 'read')
    const waiting = page.getByRole('button', { name: '打开终端并交还', exact: true })
    await waiting.waitFor()
    assert.equal(tickets.calls.some(call => call.input.query.id === queued), false, 'queued chat is waiting for the terminal lease')
    await waiting.click()
    await panel.waitFor()
    await panel.getByRole('button', { name: '交还聊天', exact: true }).click()
    await panel.getByRole('button', { name: '结束并交还', exact: true }).click()
    await page.locator('.gb-terminal-panel').waitFor({ state: 'hidden' })
    assert.equal((await host.rpc('godbot/terminalStatus', { request: target })).active, false)
    await replyOf(host, bot, queued, 'VALUE')
    await waiting.waitFor({ state: 'hidden' })
    assert.equal(tickets.calls.filter(call => call.input.query.id === queued).length, 1)
    await assert.rejects(host.rpc('godbot/dispatch', { request: { action: 'terminal.history', terminalId } }), /原生会话/)
    context.note('owner-click-to-folder-trust', { botId: bot.id, terminalId, nativeId: terminal.nativeId,
      folderMatched: true, inputReceived: accepted.keys, bothModesSharedProcess: true })
    await verifyMemberRead(host, bot, tickets, context.note)
    assert.equal(tickets.calls.filter(call => call.name === 'write').length, 1)
    context.note('readonly-revoke-restart-handback', { readonly, revokedAfterList: held, botId: bot.id, terminalId,
      totalWrites: 1, writesAfterReadonly: 0 })
  } finally { await tickets.close() }
}
