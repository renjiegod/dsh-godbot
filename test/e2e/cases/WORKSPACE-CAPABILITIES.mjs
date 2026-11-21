import assert from 'node:assert/strict'
import { randomUUID, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { ciTeam } from '../automation-client.mjs'
import { until } from '../host.mjs'
import { openBotChat, openSettingsPage } from '../native-ui.mjs'

async function fixture() {
  const runs = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/form')) {
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
      res.end('<!doctype html><title>Demo page</title><input type="password" aria-label="Password"><button>Check</button>')
      return
    }
    if (req.method !== 'POST' || req.url !== '/agent') {
      res.writeHead(404)
      res.end()
      return
    }
    const body = []
    for await (const data of req) body.push(data)
    const input = JSON.parse(Buffer.concat(body))
    runs.push(input)
    const ids = { threadId: input.threadId, runId: input.runId }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = value => res.write('data: ' + JSON.stringify(value) + '\n\n')
    event({ type: 'RUN_STARTED', ...ids })
    event({ type: 'TOOL_CALL_START', toolCallId: 'remote-checked', toolCallName: 'check_external_status' })
    event({ type: 'TOOL_CALL_END', toolCallId: 'remote-checked' })
    event({ type: 'TOOL_CALL_RESULT', toolCallId: 'remote-checked', content: 'fixture' })
    event({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'REMOTE-ANSWER-' + runs.length })
    if (input.messages.at(-1)?.content === 'REMOTE-STOP-FIXTURE') return
    event({ type: 'RUN_FINISHED', ...ids })
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: 'http://127.0.0.1:' + server.address().port, runs, close: () => { server.closeAllConnections(); server.close() } }
}

const tool = (name, input) => [{ type: 'tool_use', name, input }]
const send = (host, sessionId, text) => host.bot('send', { sessionId, text, requestId: randomUUID() })
const ruleFixture = 'Block unattended memory writes'
const checkText = 'CHECK-AUTOMATION-FIXTURE'
const humanText = 'HUMAN-CHECK-FIXTURE'
const checkInText = 'READ-ONLY-CHECK-FIXTURE'

function programModel(host) {
  let shown = false
  let reviewed = false
  const invoked = new Set()
  host.model.reply = body => {
    const latest = JSON.stringify(body.messages?.findLast(row => row.role === 'user')?.content ?? '')
    const input = JSON.stringify(body.messages ?? [])
    for (const marker of [humanText, checkText, checkInText]) {
      if (latest.includes(marker)) {
        if (invoked.has(marker)) return marker + '-REPORT'
        invoked.add(marker)
        return tool('remember', { text: marker + ' prefers concise answers.' })
      }
    }
    if (input.includes('Goal of the browser demonstration')) {
      assert.ok(!input.includes('secret-recording-value'))
      return JSON.stringify({ action: 'create', name: 'verify-demo-form', description: 'Check a record in the demo form',
        content: 'Open the demo site. Verify the form is present. Use the caller’s value to check a record.', why: 'The operator showed the form.' })
    }
    if (latest.includes('CARD-REQUEST')) {
      if (shown) return 'The card is ready.'
      shown = true
      return tool('show_component', { name: 'platform-review', values: { summary: 'FIXTURE-REVIEW' } })
    }
    if (latest.includes('FIXTURE-REVIEW-ACCEPT') || latest.includes('confirmed')) {
      reviewed = true
      return 'REVIEW-RECORDED'
    }
    return reviewed ? 'REVIEW-RECORDED' : 'Fixture answer'
  }
}

async function configureCard(host, ci) {
  const { page } = host
  await openSettingsPage(host, '业务组件')
  const card = {
    title: '发布验收',
    parameters: { summary: 'string' },
    functions: ['bot-status'],
    view: { type: 'stack', children: [
      { type: 'text', text: '{{bot_name}} · {{summary}}' },
      { type: 'confirm', id: 'finish-review', confirmLabel: 'FIXTURE-REVIEW-ACCEPT', cancelLabel: '退回' },
    ] },
  }
  await page.getByLabel('组件名称').fill('platform-review')
  await page.getByLabel('组件定义').fill(JSON.stringify(card))
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await page.getByRole('button', { name: '发布已保存草稿' }).click()
  await page.getByText('已发布 v1', { exact: true }).waitFor()
  await page.getByRole('checkbox', { name: ci.member.name, exact: true }).check()
  await page.getByRole('checkbox', { name: /^当前 Bot 状态/ }).check()
  await page.getByRole('button', { name: '保存授权', exact: true }).click()
  await until(async () => {
    const { components } = await ci.owner('components.list')
    return components[0]?.bots.includes(ci.member.id) && components[0].allowedFunctions.includes('bot-status')
  }, 'published component grants')
  await page.locator('button.bt-settings-close:visible').click()
  await openBotChat(host, ci.member)
  await send(host, ci.member.id, 'CARD-REQUEST')
  await page.getByText(ci.member.name + ' · FIXTURE-REVIEW', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'FIXTURE-REVIEW-ACCEPT', exact: true }).click()
  await until(async () => !(await host.bot('state')).views?.[ci.member.sessionId ?? ci.member.id], 'component form settled')
}

async function recordDemo(host, ci, origin) {
  const { page } = host
  await page.getByRole('button', { name: '打开网页浏览器' }).click()
  const browser = page.locator('.gb-modal')
  await browser.getByRole('button', { name: '打开执行环境' }).click()
  await browser.getByRole('button', { name: '接管网页' }).click()
  await browser.getByText('你正在控制', { exact: true }).waitFor()
  await browser.getByText('浏览器示范', { exact: true }).click()
  await browser.getByLabel('示范目标').fill('Verify a record in a site form')
  await browser.getByRole('button', { name: '开始录制', exact: true }).click()
  await browser.getByRole('button', { name: '结束录制', exact: true }).waitFor()
  await browser.getByLabel('网页地址').fill(origin + '/form?private=secret-recording-value')
  await browser.getByRole('button', { name: '打开地址', exact: true }).click()
  await browser.getByText('Demo page', { exact: true }).waitFor()
  await browser.getByAltText('实时浏览器画面').click({ position: { x: 40, y: 10 } })
  await browser.getByLabel('输入到当前网页的内容').fill('secret-recording-value')
  await browser.getByRole('button', { name: '输入到网页', exact: true }).click()
  await browser.getByRole('button', { name: '结束录制', exact: true }).click()
  const { records } = await ci.owner('browser.teaching.list', { botId: ci.member.id, sessionId: ci.member.sessionId ?? ci.member.id })
  assert.equal(records.length, 1)
  assert.ok(records[0].steps.some(step => step.action === 'fill'))
  assert.doesNotMatch(JSON.stringify(records), /secret-recording-value|\/form\?/)
  await browser.getByText(/Verify a record in a site form · \d+ 步/).click()
  await browser.getByRole('button', { name: '整理成 Skill 提案' }).click()
  await browser.getByText('Skill 提案已送到 Bot 私聊等待审核', { exact: true }).waitFor()
  await browser.getByRole('button', { name: '关闭面板' }).click()
  await until(async () => (await host.bot('state')).learningProposals?.[ci.member.id]?.some(row => row.demonstration?.id === records[0].id)
    || await page.getByText('verify-demo-form', { exact: true }).count(), 'browser demonstration learning card')
  const before = (await host.bot('state')).bots.find(bot => bot.id === ci.member.id)
  assert.ok(!before.capabilities?.includes('verify-demo-form'))
  const proposal = page.locator('.bt-learning-card').filter({ hasText: 'verify-demo-form' })
  await proposal.getByRole('button', { name: /^(接受|批准|Apply|Approve|Allow)$/ }).click()
  await until(async () => (await host.bot('state')).bots.find(bot => bot.id === ci.member.id).capabilities?.includes('verify-demo-form'), 'approved demonstration skill attached')
}

async function exerciseAutomation(host, ci) {
  const { page } = host
  await openSettingsPage(host, '执行策略')
  const rule = page.locator('.gb-platform form').first()
  await rule.getByLabel('规则名称').fill(ruleFixture)
  await rule.getByLabel('工具', { exact: true }).fill('remember')
  await rule.locator('select[name=effect]').selectOption('deny')
  await rule.getByRole('button', { name: '保存规则' }).click()
  await until(async () => (await ci.owner('governance.view')).rules.some(row => row.name === ruleFixture), 'saved execution rule')
  await page.locator('button.bt-settings-close:visible').click()
  await openBotChat(host, ci.member)
  await send(host, ci.member.id, humanText)
  await until(async () => (await ci.owner('governance.view')).audit.some(row => row.name === 'remember' && row.origin.kind === 'person' && row.decision === 'allow'), 'same tool allowed in a direct turn')

  await openSettingsPage(host, '自动化')
  const form = page.getByRole('form', { name: '统一创建自动化' })
  await form.getByLabel('执行方式').selectOption('task')
  await form.getByLabel('执行对象').selectOption(ci.member.id)
  await form.getByLabel('任务名称').fill(checkText)
  await form.getByLabel('执行要求与验收条件').fill('Return evidence of the check')
  await form.getByLabel('重复方式').selectOption('interval')
  await form.getByRole('button', { name: '创建自动化', exact: true }).click()
  await page.getByText('自动化已创建', { exact: true }).waitFor()
  const { routines } = await ci.owner('automation.routine.list')
  const routine = routines.find(row => row.title === checkText)
  assert.ok(routine)
  await ci.owner('automation.routine.run', { id: routine.id, requestId: randomUUID() })
  const audit = await until(async () => (await ci.owner('governance.view')).audit.find(row => row.name === 'remember' && row.origin.kind === 'schedule' && row.decision === 'deny'), 'scheduled turn denied by unattended rule')
  assert.equal(audit.origin.triggerId, routine.id)

  const checkBot = await ci.extra('Check-in fixture Bot')
  const request = { title: 'Scheduled message fixture', target: { kind: 'message', id: checkBot.id }, instructions: checkInText,
    trigger: { kind: 'schedule', when: { kind: 'interval', minutes: 60 } }, requestId: randomUUID(), checkOnly: true }
  const scheduled = await ci.owner('automation.setup.create', request)
  assert.equal((await ci.owner('automation.setup.create', request)).id, scheduled.id)
  const schedule = (await ci.owner('team-workspace.scheduleList')).tasks.find(task => task.id === scheduled.id)
  await ci.owner('team-workspace.scheduleRun', { id: schedule.id, sessionId: schedule.sessionId })
  await until(async () => (await ci.owner('governance.view')).audit.some(row =>
    row.botId === checkBot.id && row.name === 'remember' && row.reason === '此自动化只检查并反馈' && row.origin.triggerId === schedule.id),
  'check-in restriction carried by the DSH schedule')

  const worker = await ci.extra('Webhook fixture Bot')
  const workflow = await ci.owner('workflow.save', { name: 'Fixture event workflow',
    nodes: [{ id: 'check', title: 'Check the event', ownerId: worker.id, criteria: 'Return one result' }], edges: [] })
  const hook = await ci.owner('automation.setup.create', { title: 'Webhook workflow', requestId: randomUUID(),
    target: { kind: 'workflow', id: workflow.id, revision: workflow.revision }, trigger: { kind: 'webhook' } })
  const id = randomUUID()
  const body = JSON.stringify({ source: 'fixture' })
  const signature = createHmac('sha256', hook.secret).update(id + '\n' + body).digest('hex')
  const post = () => fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-godbot-delivery': id, 'x-godbot-signature': signature }, body })
  const response = await post()
  assert.equal(response.status, 202, await response.clone().text())
  const { runId, workflowId, workflowRevision } = await response.json()
  assert.equal(workflowId, workflow.id)
  assert.equal(workflowRevision, workflow.revision)
  assert.equal((await (await post()).json()).runId, runId)
  let status
  await until(async () => {
    status = (await ci.owner('workflow.list')).runs.find(run => run.id === runId)
    return status?.nodes[0]?.status === 'reported'
  }, 'signed webhook ran the pinned workflow').catch(error => {
    throw new Error(error.message + ' · ' + JSON.stringify(status), { cause: error })
  })
}

async function exerciseRemote(host, ci, fixture) {
  const { page } = host
  await openSettingsPage(host, '远程 Agent')
  await page.getByLabel('名称', { exact: true }).fill('Fixture AG-UI')
  await page.getByLabel('AG-UI 运行地址').fill(fixture.origin + '/agent')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  const remote = await until(async () => (await ci.owner('remote-agents.list')).agents.find(row => row.name === 'Fixture AG-UI'), 'registered route')
  await page.locator('button.bt-settings-close:visible').click()
  const bot = await ci.extra('Remote fixture Bot')
  await host.bot('update-bot', { id: bot.id, model: remote.route, changeEngine: true })
  await openBotChat(host, bot)
  await send(host, bot.id, 'REMOTE-TEST-ONE')
  await page.getByText(/^REMOTE-ANSWER-\d+$/, { exact: true }).last().waitFor()
  const state = (await host.bot('state')).bots.find(row => row.id === bot.id)
  const sessionId = state.sessionId ?? bot.id
  const events = await until(async () => {
    const value = await ci.owner('remote-agents.events', { sessionId })
    return value.events.some(row => row.kind === 'finished') && value
  }, 'remote execution finished')
  await send(host, bot.id, 'REMOTE-TEST-TWO')
  await until(async () => fixture.runs.some(run => run.messages.some(row => row.content.includes('REMOTE-TEST-TWO'))), 'second AG-UI turn received')
  const after = await until(async () => {
    const page = await ci.owner('remote-agents.events', { sessionId, after: events.cursor })
    return page.events.some(row => row.kind === 'finished') && page
  }, 'resumed activity stream sees the next completed remote turn')
  assert.equal(after.version, 1)
  assert.ok(after.events.every(row => row.seq > events.cursor))
  assert.deepEqual((await ci.owner('remote-agents.events', { sessionId, after: after.cursor })).events, [])
  const sent = fixture.runs.find(run => run.messages.some(row => row.content.includes('REMOTE-TEST-TWO')))
  assert.equal(sent.threadId, sessionId)
  assert.deepEqual(sent.tools, [])
  assert.ok(sent.messages.some(row => row.role === 'assistant' && row.content.includes('REMOTE-ANSWER-')))
  await send(host, bot.id, 'REMOTE-STOP-FIXTURE')
  await until(async () => fixture.runs.some(run => run.messages.at(-1)?.content === 'REMOTE-STOP-FIXTURE'), 'interruptible AG-UI fixture started')
  await host.bot('stop-chat', { botId: bot.id })
  await until(async () => (await ci.owner('remote-agents.events', { sessionId, after: after.cursor })).events.some(row => row.kind === 'disconnected'), 'stop ended the local stream')
  assert.equal(fixture.runs.filter(run => run.messages.at(-1)?.content === 'REMOTE-STOP-FIXTURE').length, 1)
  const task = await ci.owner('task.create', { ownerId: bot.id, title: 'REMOTE-TASK-FIXTURE', criteria: 'Return a short result' })
  const dispatched = await until(async () => {
    const run = fixture.runs.find(run => run.messages.at(-1)?.content.includes('REMOTE-TASK-FIXTURE'))
    const current = (await ci.owner('team-workspace.management')).tasks.find(row => row.id === task.id)
    return run && current?.status === 'reported' && current
  }, 'remote Agent reported back to a manually assigned task')
  assert.match(dispatched.evidence, /REMOTE-ANSWER-/)
  const openHistory = page.getByRole('button', { name: '查看会话执行记录', exact: true })
  await openHistory.click()
  const activity = page.locator('details').filter({ has: page.getByText('远程 Agent 事件', { exact: true }) })
  await activity.getByText(/远端工具返回 · check_external_status/).first().waitFor()
  const positions = activity.getByRole('listitem')
  const initialCount = await positions.count()
  await page.getByRole('button', { name: '关闭执行记录', exact: true }).click()
  await openHistory.click()
  await until(async () => await positions.count() === initialCount, 'reopening the panel replayed exactly the same remote activity')
  return sessionId
}

export default async function capabilities({ makeHost, candidate, note }) {
  const remote = await fixture()
  try {
    const host = await makeHost({ patch: [{ id: 'godbot', config: { teamWorkspace: { remoteAgents: { allowPrivateOrigins: [remote.origin] } } } }] })
    const ci = await ciTeam(host, candidate)
    programModel(host)
    await configureCard(host, ci)
    note('component-published-and-answered')
    await recordDemo(host, ci, remote.origin)
    note('demonstration-approved')
    await exerciseAutomation(host, ci)
    note('unified-automation-governance-and-webhook')
    const remoteSession = await exerciseRemote(host, ci, remote)
    note('remote-ag-ui-round-trip', { runs: remote.runs.length })
    await host.restart()
    const policy = await ci.owner('governance.preview', { origin: 'schedule', tool: 'remember', botId: ci.member.id })
    assert.equal(policy.decision, 'deny')
    assert.ok((await ci.owner('governance.export')).audit.some(row => row.reason === ruleFixture))
    assert.ok((await ci.owner('components.list')).components.some(row => row.name === 'platform-review' && row.published?.version === 1))
    assert.ok((await ci.owner('remote-agents.list')).agents.some(row => row.endpoint === remote.origin + '/agent'))
    assert.ok((await ci.owner('remote-agents.events', { sessionId: remoteSession })).events.some(row => row.kind === 'finished'))
    const { records } = await ci.owner('browser.teaching.list', { botId: ci.member.id, sessionId: ci.member.sessionId ?? ci.member.id })
    assert.equal(records.length, 1)
    note('saved-configuration-and-activity-survived-host-restart')
  } finally {
    remote.close()
  }
}
