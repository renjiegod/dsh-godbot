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
  const middle = 'Claude fixture progress after both tool starts.'
  const rewire = 'Now rewire the fixture routing.'
  const codexProgress = 'Codex fixture progress before the command.'
  const codexDuring = 'Codex fixture progress while the command runs.'
  const acpProgress = 'ACP fixture progress after the read starts.'
  const reportBody = 'Tool results and final checks are included.'
  const reportHeading = 'Fixture verification report'
  const claudeTools = [
    ['Read', 'completed', ['fixture-trace.txt', 'Claude fixture file content']],
    ['Grep', 'failed', ['fixture-trace.txt', 'Claude fixture grep error']],
  ]
  const bashRunning = ['Bash', 'running', ['node --version'], [], 'Read fixture version']
  const bashFinished = ['Bash', 'failed', ['node --version', 'Claude fixture standard output', 'Claude fixture standard error'], ['标准输出', '标准错误'], 'Read fixture version']
  const claudeOrder = (initialStatus, lateStatus) => [
    progress, ['Read', 'completed'], ['Grep', 'failed'], middle, ['Bash', initialStatus, 'Read fixture version'],
    ['Bash', 'completed', 'Check fixture route 1'], ['Bash', 'completed', 'Check fixture route 72'],
    rewire, ['Bash', 'completed', 'Read the new fixture route'], ['Bash', lateStatus, 'Verify the new fixture route'],
  ]
  const codexTools = [['Shell', 'completed', ['cat fixture-trace.txt', 'Codex fixture command output'], [], 'fixture-trace.txt']]
  const acpTools = [
    ['Read', 'completed', ['acp-fixture-trace.txt', 'ACP fixture file content'], [], 'acp-fixture-trace.txt'],
    ['Search', 'failed', ['needle from fixture', 'ACP fixture search error']],
    ['Edit', 'completed', ['acp-fixture-trace.txt', 'before fixture edit', 'after fixture edit'], ['文件变更', '修改前', '修改后']],
  ]
  const openChat = async bot => {
    await page.locator('.bt-row-title').filter({ hasText: bot.name }).click()
    await page.locator('.bt-head .bt-pill-name').filter({ hasText: bot.name }).waitFor()
  }
  const step = (scope, name, status, target) => {
    const row = scope.locator(`details[data-gb-execution-tool][data-status="${status}"]`)
      .filter({ has: page.getByText(name, { exact: true }) })
    return target ? row.filter({ has: page.getByText(target, { exact: true }) }) : row
  }
  const verifyTool = async (scope, [name, status, markers, sections = [], target]) => {
    const row = step(scope, name, status, target)
    await row.waitFor()
    if (!await row.evaluate(element => element.open)) await row.locator('summary').click()
    for (const marker of markers) await row.locator('pre').filter({ hasText: marker }).first().waitFor()
    for (const label of sections) await row.getByRole('heading', { name: label, exact: true }).waitFor()
  }
  const verifySteps = async expected => {
    for (const tool of expected) await verifyTool(flow, tool)
  }
  const verifyOrder = async (scope, sequence) => {
    let previous
    for (const reference of sequence) {
      const item = Array.isArray(reference) ? step(scope, ...reference) : scope.getByText(reference, { exact: true })
      await item.waitFor()
      assert.equal(await item.count(), 1, 'one row for ' + reference)
      if (previous) {
        const handle = await item.elementHandle()
        assert.equal(await previous.evaluate((node, next) => Boolean(node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING), handle),
          true, 'out of order near ' + reference)
        await handle.dispose()
      }
      previous = item
    }
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
  const allowReceipts = Promise.withResolvers()
  let receiptWaiting = false
  const delayReceipts = async route => {
    if (/"onlyTools":\s*true/u.test(route.request().postData() ?? '')) {
      receiptWaiting = true
      await allowReceipts.promise
    }
    await route.continue()
  }
  const dispatchRoute = '**/api/godbot/dispatch'
  await page.route(dispatchRoute, delayReceipts)
  try {
    await openChat(claude)
    await until(() => receiptWaiting, 'the tool receipt request is waiting')
    await verifyOrder(flow, [progress, ['Read', 'running']])
  } finally {
    allowReceipts.resolve()
    await page.unrouteAll({ behavior: 'wait' })
  }
  assert.equal(await step(flow, 'Grep', 'running').count(), 0, 'Claude is paused before the complete assistant frame')
  await writeFile(join(host.workspace, 'claude-execution-trace-start'), '')
  await verifySteps([...claudeTools, bashRunning])
  await verifyOrder(flow, [progress, ['Read', 'completed'], ['Grep', 'failed'], middle, ['Bash', 'running', 'Read fixture version']])
  await writeFile(join(host.workspace, 'claude-execution-trace-continue'), '')
  await verifyOrder(flow, claudeOrder('running', 'running'))
  assert.equal(await flow.locator('details[data-gb-execution-tool]').filter({ has: page.getByText('Bash', { exact: true }) }).count(), 75)
  assert.equal(await flow.getByText(progress, { exact: true }).count(), 1, 'Claude streamed its progress once')
  assert.equal(await flow.getByText(reportHeading, { exact: true }).count(), 0, 'the report has not arrived yet')
  assert.equal((await claudeRun.exchange()).some(row => row.replyTo === claudeRun.requestId), false, 'activity visible before Claude replies')
  await host.capture('delegated-claude-live')

  await page.reload()
  await openFullTeam(host)
  await openChat(claude)
  await verifySteps([...claudeTools, bashRunning])
  await verifyOrder(flow, claudeOrder('running', 'running'))
  await writeFile(join(host.workspace, 'claude-execution-trace-release'), '')
  const claudeReply = await claudeRun.waitForReply()
  await verifySteps([bashFinished])
  await verifyReport(claudeRun.marker)
  const settledClaudeOrder = [...claudeOrder('failed', 'completed'), reportHeading]
  await verifyOrder(flow, settledClaudeOrder)
  assert.equal(await flow.getByText(progress, { exact: true }).count(), 1, 'completion did not repeat streamed progress')

  const codexTarget = await member(host, 'Execution Codex', 'local-codex-cli/default')
  const codexRun = await delegate(codexTarget, 'CODEX')
  await openChat(codexTarget)
  await verifyOrder(flow, [codexProgress, ['Shell', 'running', 'fixture-trace.txt'], codexDuring])
  await writeFile(join(host.workspace, 'codex-execution-trace-release'), '')
  const codexReply = await codexRun.waitForReply()
  await verifySteps(codexTools)
  await verifyReport(codexRun.marker)
  await verifyOrder(flow, [codexProgress, ['Shell', 'completed', 'fixture-trace.txt'], codexDuring, reportHeading])
  assert.equal(await flow.getByText('Claude fixture file content', { exact: true }).count(), 0, 'Claude output stays in its own chat')

  const acpTarget = await member(host, 'Execution Antigravity', 'local-antigravity/default')
  const acpRun = await delegate(acpTarget, 'ACP')
  await openChat(acpTarget)
  await verifyOrder(flow, [['Read', 'running', 'acp-fixture-trace.txt']])
  assert.equal(await flow.getByText(acpProgress).count(), 0, 'ACP tool is visible before any response text')
  await writeFile(join(host.workspace, 'acp-execution-trace-release'), '')
  const acpReply = await acpRun.waitForReply()
  await verifySteps(acpTools)
  await verifyReport(acpRun.marker)

  await host.restart()
  await openFullTeam(host)
  for (const [bot, tools, delegated, order] of [
    [claude, [...claudeTools, bashFinished], claudeRun, settledClaudeOrder],
    [codexTarget, codexTools, codexRun, [codexProgress, ['Shell', 'completed', 'fixture-trace.txt'], codexDuring, reportHeading]],
    [acpTarget, acpTools, acpRun, [['Read', 'completed', 'acp-fixture-trace.txt'], acpProgress, ['Search', 'failed'], ['Edit', 'completed'], reportHeading]],
  ]) {
    await openChat(bot)
    await verifySteps(tools)
    await verifyReport(delegated.marker)
    await verifyOrder(flow, order)
    assert.equal((await delegated.exchange()).filter(row => row.id === delegated.requestId || row.replyTo === delegated.requestId).length, 2)
  }
  await openChat(claude)
  await page.getByRole('button', { name: '查看会话执行记录', exact: true }).click()
  const history = page.getByRole('region', { name: '会话执行记录', exact: true })
  await history.getByRole('button', { name: /^原生会话回合/u }).click()
  await history.getByText('Historical Claude report from native conversation.', { exact: true }).waitFor()
  await verifyTool(history, ['Bash', 'completed', ['printf earlier-fixture', 'The historical native command ran.']])
  const recent = history.getByRole('button', { name: /^回合 \d+/u }).first()
  await recent.click()
  const settled = recent.locator('..')
  await verifyOrder(settled, settledClaudeOrder)
  note('delegated-execution', {
    claude: { requestId: claudeRun.requestId, replyId: claudeReply, steps: claudeTools.length + 75, visibleBeforeReply: true, nativeBackfill: true },
    codex: { requestId: codexRun.requestId, replyId: codexReply, steps: codexTools.length },
    acp: { requestId: acpRun.requestId, replyId: acpReply, steps: acpTools.length },
    recoveredAfterRestart: true,
  })
}
