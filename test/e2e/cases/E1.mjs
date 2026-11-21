import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { ticketEnvironment, member, sendTicket, replyOf, verifyMemberRead } from '../tickets.mjs'

export default async function E1(context) {
  const { host, tickets } = await ticketEnvironment({
    ...context,
    makeHost: () => context.makeHost({ env: { CLAUDE_CODE_CHILD_SESSION: 'inherited-test-marker' } }),
  }, { antigravity: true })
  try {
    const outsider = await member(host, 'Unassigned Reader', 'local-codex-cli/default')
    await host.bot('connector-set', { id: 'tickets', offFor: [outsider.id] })
    const agents = []
    for (const [name, model] of [['Reader DSH', 'deepseek-official/deepseek-flash'],
      ['Reader Claude', 'local-claude-code/default'], ['Reader Codex', 'local-codex-cli/default']]) {
      agents.push(await member(host, name, model))
    }
    // Bot creation returns before its provider is applied and its greeting runs.
    // A connector read belongs to the chat part that issued it. Start this
    // scenario once setup has settled so the drawer observes that same part.
    await Promise.all([outsider, ...agents].map(bot => until(async () =>
      (await host.bot('chat', { botId: bot.id })).items?.some(item => item.kind === 'bot'),
    bot.name + ' finished its setup greeting')))
    const marker = await sendTicket(host, outsider, 'list')
    await Promise.all([replyOf(host, outsider, marker, 'LIST').then(text => assert.ok(text.includes(marker + ' disabled'))),
      ...agents.map(bot => verifyMemberRead(host, bot, tickets, context.note))])
    const { page } = host
    await page.locator('.bt-row-title').filter({ hasText: 'Reader Codex' }).first().click()
    await page.locator('.bt-head .bt-pill-name').filter({ hasText: 'Reader Codex' }).first().click()
    const panel = page.locator('details').filter({ has: page.getByText('连接器工具', { exact: true }) })
    await panel.locator('summary').click()
    await panel.getByText('mcp__tickets__read', { exact: true }).waitFor()
    await panel.getByText(/最近调用成功/).waitFor()
    await host.capture('codex-connector-tools')
    assert.equal(tickets.calls.length, 3)
    context.note('separate-member', { outsider: outsider.id, unauthorizedUpstreamCalls: 0 })

    const [dsh, claude, codex] = agents
    const terminal = page.locator('.bt-head').getByRole('button', { name: '原生 Agent', exact: true })
    const headers = []
    for (const current of [claude, codex, dsh, codex, claude, dsh, codex]) {
      await page.locator('.bt-row-title').filter({ hasText: current.name }).click()
      await page.locator('.bt-head .bt-pill-name').filter({ hasText: current.name }).waitFor()
      const buttons = await terminal.count()
      assert.equal(buttons, current === dsh ? 0 : 1, current.name + ' terminal buttons after switching chats')
      headers.push({ name: current.name, buttons })
    }
    // Wait for a visible roster update while the selected session stays mounted.
    for (const name of ['Renamed Codex', codex.name]) {
      await host.bot('update-bot', { id: codex.id, name })
      await page.locator('.bt-head .bt-pill-name').filter({ hasText: name }).waitFor()
      assert.equal(await terminal.count(), 1, 'Current chat retained a single terminal button after rename')
    }
    context.note('terminal-buttons-after-chat-switch', { headers, sameChatUpdates: 2 })
    await verifyDelegatedTrace(host, codex, claude, context.note)
  } finally { await tickets.close() }
}

async function verifyDelegatedTrace(host, codex, claude, note) {
  const { page } = host
  const flow = page.locator('[data-chat-flow]')
  const progress = 'Claude fixture progress before the report.'
  const reportBody = 'Tool results and final checks are included.'
  const reportHeading = 'Fixture verification report'
  const claudeTools = [
    ['Read', 'completed', ['fixture-trace.txt', 'Claude fixture file content']],
    ['Grep', 'failed', ['fixture-trace.txt', 'Claude fixture grep error']],
  ]
  const bashRunning = ['Bash', 'running', ['node --version']]
  const bashFinished = ['Bash', 'failed', ['node --version', 'Claude fixture standard output', 'Claude fixture standard error'], ['标准输出', '标准错误']]
  const codexTools = [['Shell', 'completed', ['cat fixture-trace.txt', 'Codex fixture command output']]]
  const acpTools = [
    ['Read', 'completed', ['acp-fixture-trace.txt', 'ACP fixture file content']],
    ['Search', 'failed', ['needle from fixture', 'ACP fixture search error']],
    ['Edit', 'completed', ['acp-fixture-trace.txt', 'before fixture edit', 'after fixture edit'], ['文件变更', '修改前', '修改后']],
  ]
  const openChat = async bot => {
    await page.locator('.bt-row-title').filter({ hasText: bot.name }).click()
    await page.locator('.bt-head .bt-pill-name').filter({ hasText: bot.name }).waitFor()
  }
  const step = (scope, name, status) => scope.locator(`details[data-gb-execution-tool][data-status="${status}"]`)
    .filter({ has: page.getByText(name, { exact: true }) })
  const verifyTool = async (scope, [name, status, markers, sections = []]) => {
    const row = step(scope, name, status)
    await row.waitFor()
    if (!await row.evaluate(element => element.open)) await row.locator('summary').click()
    for (const marker of markers) await row.locator('pre').filter({ hasText: marker }).first().waitFor()
    for (const label of sections) await row.getByRole('heading', { name: label, exact: true }).waitFor()
  }
  const verifySteps = async expected => {
    const section = flow.locator('[data-gb-delegated-activity]').last()
    const expand = section.getByRole('button', { name: /^执行记录(?: · \d+)?$/u })
    await expand.waitFor()
    if (await expand.getAttribute('aria-expanded') === 'false') await expand.click()
    for (const tool of expected) await verifyTool(section, tool)
  }
  const verifyReport = async marker => {
    await flow.getByText('TRACE_COMPLETE ' + marker, { exact: true }).waitFor()
    await flow.getByText(reportHeading, { exact: true }).waitFor()
    await flow.getByText(reportBody, { exact: true }).waitFor()
  }
  const delegate = async (bot, agent) => {
    const marker = randomUUID()
    const task = `GODBOT-${agent}-EXECUTION-TRACE ${marker}`
    const exchange = () => host.bot('exchange', { a: codex.id, b: bot.id })
    await host.bot('send', { sessionId: codex.id, text: `GODBOT-CODEX-DELEGATE ${agent} ${marker} ${bot.name}` })
    const request = await until(async () => (await exchange()).find(row => row.role === 'request' && row.text === task), `Codex delegated to ${bot.name} through message_bot`)
    assert.equal(request.from, codex.id)
    assert.equal(request.to, bot.id)
    const waitForReply = async () => {
      const reply = await until(async () => (await exchange()).find(row => row.role === 'reply' && row.replyTo === request.id), `${bot.name} result delivered back to Codex`)
      assert.equal(reply.from, bot.id)
      assert.equal(reply.to, codex.id)
      assert.ok(reply.text.endsWith('TRACE_COMPLETE ' + marker + '\n\n## ' + reportHeading + '\n\n' + reportBody), 'the same complete report reached the original sender')
      return reply.id
    }
    return { exchange, marker, requestId: request.id, waitForReply }
  }

  const claudeRun = await delegate(claude, 'CLAUDE')
  await openChat(claude)
  await verifySteps([...claudeTools, bashRunning])
  assert.equal(await flow.getByText(progress, { exact: true }).count(), 1, 'Claude streamed its progress once')
  assert.equal(await flow.getByText(reportHeading, { exact: true }).count(), 0, 'the report has not arrived yet')
  assert.equal((await claudeRun.exchange()).some(row => row.replyTo === claudeRun.requestId), false, 'activity visible before Claude replies')
  await host.capture('delegated-claude-live')

  await page.reload()
  await openFullTeam(host)
  await openChat(claude)
  await verifySteps([...claudeTools, bashRunning])
  await writeFile(join(host.workspace, 'claude-execution-trace-release'), '')
  const claudeReply = await claudeRun.waitForReply()
  await verifySteps([bashFinished])
  await verifyReport(claudeRun.marker)
  assert.equal(await flow.getByText(progress, { exact: true }).count(), 1, 'completion did not repeat streamed progress')

  const codexTarget = await member(host, 'Execution Codex', 'local-codex-cli/default')
  const codexRun = await delegate(codexTarget, 'CODEX')
  const codexReply = await codexRun.waitForReply()
  await openChat(codexTarget)
  await verifySteps(codexTools)
  await verifyReport(codexRun.marker)
  assert.equal(await flow.getByText('Claude fixture file content', { exact: true }).count(), 0, 'Claude output stays in its own chat')

  const acpTarget = await member(host, 'Execution Antigravity', 'local-antigravity/default')
  const acpRun = await delegate(acpTarget, 'ACP')
  const acpReply = await acpRun.waitForReply()
  await openChat(acpTarget)
  await verifySteps(acpTools)
  await verifyReport(acpRun.marker)

  await host.restart()
  await openFullTeam(host)
  for (const [bot, tools, delegated] of [[claude, [...claudeTools, bashFinished], claudeRun], [codexTarget, codexTools, codexRun], [acpTarget, acpTools, acpRun]]) {
    await openChat(bot)
    await verifySteps(tools)
    await verifyReport(delegated.marker)
    assert.equal((await delegated.exchange()).filter(row => row.id === delegated.requestId || row.replyTo === delegated.requestId).length, 2)
  }
  await openChat(claude)
  await page.getByRole('button', { name: '查看会话执行记录', exact: true }).click()
  const history = page.getByRole('region', { name: '会话执行记录', exact: true })
  await history.getByRole('button', { name: /^原生会话回合/u }).click()
  await history.getByText('Historical Claude report from native conversation.', { exact: true }).waitFor()
  await verifyTool(history, ['Bash', 'completed', ['printf earlier-fixture', 'The historical native command ran.']])
  note('delegated-execution', {
    claude: { requestId: claudeRun.requestId, replyId: claudeReply, steps: claudeTools.length + 1, visibleBeforeReply: true, nativeBackfill: true },
    codex: { requestId: codexRun.requestId, replyId: codexReply, steps: codexTools.length },
    acp: { requestId: acpRun.requestId, replyId: acpReply, steps: acpTools.length },
    recoveredAfterRestart: true,
  })
}
