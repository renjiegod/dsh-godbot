import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
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
    await verifyNativeToolGroups(host, dsh)
    await verifyCodexConversation(host, codex, context.note)
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
  const groupFor = row => row.locator('xpath=../..').locator(':scope > [data-gb-tool-group]')
  const openGroup = async (row, count, collapsed = false) => {
    const group = groupFor(row)
    await group.getByText(`${count} 次工具调用`, { exact: true }).waitFor()
    if (collapsed) {
      assert.equal(await group.getAttribute('aria-expanded'), 'false')
      await row.waitFor({ state: 'hidden' })
    }
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await row.waitFor()
    return group
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
  const read = step(flow, 'Read', 'completed')
  const readGroup = await openGroup(read, 2, true)
  assert.equal(await readGroup.innerText(), '2 次工具调用', 'the group summary shows only the total after calls finish')
  await readGroup.press('Space')
  await read.waitFor({ state: 'hidden' })
  await flow.getByText(middle, { exact: true }).waitFor()
  await readGroup.press('Enter')
  await verifySteps([...claudeTools, bashRunning])
  const bash = step(flow, 'Bash', 'running', 'Read fixture version')
  assert.equal(await read.getAttribute('data-gb-tool-kind'), 'read')
  assert.equal(await bash.getAttribute('data-gb-tool-kind'), 'command')
  await verifyOrder(flow, [progress, ['Read', 'completed'], ['Grep', 'failed'], middle, ['Bash', 'running', 'Read fixture version']])
  await writeFile(join(host.workspace, 'claude-execution-trace-continue'), '')
  const late = status => step(flow, 'Bash', status, 'Verify the new fixture route')
  await openGroup(bash, 73)
  await openGroup(late('running'), 2, true)
  await verifyOrder(flow, claudeOrder('running', 'running'))
  assert.equal(await flow.locator('details[data-gb-execution-tool]').filter({ has: page.getByText('Bash', { exact: true }) }).count(), 75)
  assert.equal(await flow.getByText(progress, { exact: true }).count(), 1, 'Claude streamed its progress once')
  assert.equal(await flow.getByText(reportHeading, { exact: true }).count(), 0, 'the report has not arrived yet')
  assert.equal((await claudeRun.exchange()).some(row => row.replyTo === claudeRun.requestId), false, 'activity visible before Claude replies')
  await host.capture('delegated-claude-live')

  await page.reload()
  await openFullTeam(host)
  await openChat(claude)
  const replayGroup = await openGroup(read, 2, true)
  assert.equal(await replayGroup.innerText(), '2 次工具调用', 'replaying the chat keeps the settled group summary')
  await openGroup(bash, 73, true)
  await openGroup(late('running'), 2, true)
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
  assert.equal(await step(flow, 'Read', 'running', 'acp-fixture-trace.txt').getAttribute('data-gb-tool-kind'), 'read')
  assert.equal(await flow.getByText(acpProgress).count(), 0, 'ACP tool is visible before any response text')
  await writeFile(join(host.workspace, 'acp-execution-trace-release'), '')
  const acpReply = await acpRun.waitForReply()
  const search = step(flow, 'Search', 'failed')
  await openGroup(search, 2, true)
  await verifySteps(acpTools)
  assert.equal(await search.getAttribute('data-gb-tool-kind'), 'search')
  assert.equal(await step(flow, 'Edit', 'completed', 'acp-fixture-trace.txt').getAttribute('data-gb-tool-kind'), 'edit')
  await verifyReport(acpRun.marker)

  await host.restart()
  await openFullTeam(host)
  for (const [bot, tools, delegated, order] of [
    [claude, [...claudeTools, bashFinished], claudeRun, settledClaudeOrder],
    [codexTarget, codexTools, codexRun, [codexProgress, ['Shell', 'completed', 'fixture-trace.txt'], codexDuring, reportHeading]],
    [acpTarget, acpTools, acpRun, [['Read', 'completed', 'acp-fixture-trace.txt'], acpProgress, ['Search', 'failed'], ['Edit', 'completed'], reportHeading]],
  ]) {
    await openChat(bot)
    if (bot === claude) {
      await openGroup(read, 2, true)
      await openGroup(step(flow, 'Bash', 'failed', 'Read fixture version'), 73, true)
      await openGroup(late('completed'), 2, true)
    }
    if (bot === acpTarget) await openGroup(search, 2, true)
    await verifySteps(tools)
    await verifyReport(delegated.marker)
    await verifyOrder(flow, order)
    assert.equal((await delegated.exchange()).filter(row => row.id === delegated.requestId || row.replyTo === delegated.requestId).length, 2)
  }
  note('delegated-execution', {
    claude: { requestId: claudeRun.requestId, replyId: claudeReply, steps: claudeTools.length + 75, visibleBeforeReply: true, nativeBackfill: true },
    codex: { requestId: codexRun.requestId, replyId: codexReply, steps: codexTools.length },
    acp: { requestId: acpRun.requestId, replyId: acpReply, steps: acpTools.length },
    recoveredAfterRestart: true,
  })
}

async function verifyCodexConversation(host, bot, note) {
  const { page } = host
  await host.bot('set-prefs', { layout: 'conversation', thinking: true })
  await openBotChat(host, bot)
  const editor = page.locator('[data-composer-card] [role=textbox]')
  await editor.fill('Verify the Codex conversation layout')
  await editor.press('Enter')
  const flow = page.locator('[data-slot="conversation.chat.flow"]')
  const answer = flow.getByRole('heading', { name: 'Conversation check completed' })
  await answer.waitFor()
  const verify = async () => {
    const rows = [
      flow.getByText('I will check the review instructions.', { exact: true }).first(),
      flow.locator('[data-gb-execution-tool="process-skill"]'),
      flow.getByText('The instructions are ready. I can run the checks.', { exact: true }).first(),
      flow.locator('[data-gb-execution-tool="process-shell"]'),
      answer,
    ]
    for (const row of rows) await row.waitFor()
    await until(() => rows[1].evaluate(element => !element.closest('[hidden]')),
      'skill row exposed to browser accessibility')
    for (let i = 1; i < rows.length; i++) {
      const next = await rows[i].elementHandle()
      assert.ok(await rows[i - 1].evaluate((previous, next) =>
        Boolean(previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING), next))
    }
    assert.equal(await rows[1].getAttribute('data-gb-tool-kind'), 'skill')
    assert.equal(await rows[3].getAttribute('data-gb-tool-kind'), 'command')
    await rows[1].locator('summary').getByText('加载技能', { exact: true }).waitFor()
    await rows[3].locator('summary').getByText('运行命令', { exact: true }).waitFor()
    assert.equal(await flow.locator('.bt-think summary').filter({ hasText: 'qa-review' }).count(), 0)
  }
  await verify()
  await host.capture('codex-conversation-process')
  const skill = flow.locator('details[data-gb-execution-tool="process-skill"]')
  await skill.locator('summary').click()
  await skill.locator('pre').filter({ hasText: 'Review instructions loaded.' }).waitFor()
  await host.restart()
  await openFullTeam(host)
  await openBotChat(host, bot)
  await verify()
  note('codex-conversation-process', { categories: ['thinking', 'skill', 'thinking', 'command', 'answer'], afterRestart: true })
}

async function verifyNativeToolGroups(host, bot) {
  const { page } = host
  const id = randomUUID()
  const reply = host.model.reply
  const progress = 'Native fixture prose between calls.'
  const final = 'Native tool grouping complete.'
  const toolId = index => `toolu_${id.replaceAll('-', '')}_${index}`
  const call = index => ({ type: 'tool_use', id: toolId(index), name: 'mcp__tickets__read', input: { query: { id: `${id}-${index}` } } })
  let step = 0
  host.model.reply = (body, request) => {
    if (!JSON.stringify(body.messages).includes(id)) return reply(body, request)
    switch (++step) {
      case 1: return [call(1)]
      case 2: return [call(2)]
      case 3: return [{ type: 'text', text: progress }, call(3)]
      default: return final
    }
  }
  try {
    await page.locator('.bt-row-title').filter({ hasText: bot.name }).click()
    await page.locator('.bt-head .bt-pill-name').filter({ hasText: bot.name }).waitFor()
    await host.bot('send', { sessionId: bot.id, text: 'Run native tool grouping fixture ' + id })
    const flow = page.locator('[data-slot="conversation.chat.flow"]')
    await flow.getByText(final, { exact: true }).waitFor()
    const receipt = index => flow.locator(`details[data-gb-execution-tool="${toolId(index)}"]`)
    const first = receipt(1)
    const group = first.locator('xpath=../..').getByRole('button', { name: '2 次工具调用', exact: true })
    await group.waitFor()
    assert.equal(await group.getAttribute('aria-expanded'), 'false')
    await first.waitFor({ state: 'hidden' })
    await receipt(2).waitFor({ state: 'hidden' })
    await flow.getByText(progress, { exact: true }).waitFor()
    await receipt(3).waitFor()
    await group.click()
    await first.waitFor()
    await receipt(2).waitFor()
    await receipt(2).locator('summary').click()
    await receipt(2).getByRole('heading', { name: '输出', exact: true }).waitFor()
    await group.click()
    await receipt(2).waitFor({ state: 'hidden' })
    await group.click()
    await receipt(2).getByRole('heading', { name: '输出', exact: true }).waitFor()
  } finally {
    host.model.reply = reply
  }
}
