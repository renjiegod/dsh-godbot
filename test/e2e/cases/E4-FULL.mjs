import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ciClient, ciTeam } from '../automation-client.mjs'
import { ticketEnvironment } from '../tickets.mjs'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'

export default async function fullTeamJourney(context) {
  const { host, tickets } = await ticketEnvironment(context, { approval: true })
  try { await journey(host, tickets, context.note) } finally { await tickets.close() }
}

async function journey(host, tickets, note) {
  const native = await ciTeam(host)
  const worker = await native.extra('Full Worker')
  const bot = native.member.id
  const to = worker.id
  const room = (await host.bot('create-room', { name: 'CI review', members: [bot, to], admin: bot })).id
  const grant = targetId => native.owner('automation.grant', { targetId, label: targetId, scopes: ['run', 'inspect', 'export'] })
  await assert.rejects(grant('bot/' + randomUUID()), /accessible|bound/)
  await native.access.getByRole('button', { name: '刷新 CI 状态' }).click()
  await native.access.getByLabel('凭据执行目标').selectOption('bot/' + bot)
  await native.access.getByLabel('凭据名称').fill('Scoped full Bot')
  await native.access.getByRole('button', { name:'签发凭据' }).click()
  const shown = native.access.getByRole('status')
  const botGrant = { token:await shown.locator('pre').innerText(), url:await shown.locator('code').innerText() }
  botGrant.id = botGrant.token.split('.')[0]
  await native.access.getByRole('button', { name:'已保存' }).click()
  const roomGrant = await grant('room/' + room)
  const a = await ciClient(host, botGrant), g = await ciClient(host, roomGrant)
  const id = randomUUID(), title = 'delegate-' + randomUUID(), child = 'read-' + randomUUID()
  const childResult = 'worker-result-' + randomUUID(), roomResult = 'room-result-' + randomUUID(), revision = 'revised-' + randomUUID()
  const gate = Promise.withResolvers()
  let called = false, wrote = false, workerEntered = false, leadReturned = false, waitForCrash
  host.model.reply = async (body, call) => {
    const msgs = body.messages ?? []
    const latestUser = JSON.stringify(msgs.findLast(m => m.role === 'user')?.content)
    const latest = JSON.stringify(msgs.slice(-2))
    const has = text => latestUser.includes(text)
    if (has('crash-fixture-')) { await waitForCrash.promise; return 'late reply after crash' }
    if (has('fail-fixture-')) return { failure: { status: 400, message: 'fixture rejected turn' } }
    if (has('room-fixture-')) return roomResult
    if (has('Owner requested a revision:')) return revision
    if (has(child) && !has(title) && !workerEntered) {
      workerEntered = true
      await gate.promise
      wrote = true
      return [{ type: 'tool_use', name: 'mcp__tickets__write', input: { query: { id: 'full-run' } } }]
    }
    if (wrote && latest.includes(tickets.value)) return childResult
    if (has(title) && !called) {
      called = true
      return [{ type: 'tool_use', name: 'message_bot', input: { to: 'Full Worker', message: child } }]
    }
    if (called) leadReturned = true
    return 'Lead report ' + (has(childResult) ? childResult : 'ready')
  }
  const args = ['run','--request-id',id,'--title',title,'--criteria','Return reviewed evidence']
  const submitted = await a.cli(...args)
  assert.equal(submitted.code, 0, JSON.stringify(submitted.data))
  const runId = submitted.data.runId
  const owned = (await a.cli(...args)).data
  assert.equal(owned.runId, runId)
  assert.equal((await a.cli(...args.slice(0,-1), 'changed')).code, 2)
  const trace = async (client, runId, predicate, reason) => {
    let last
    try {
      return await until(async () => { last = (await client.cli('inspect', runId)).data; return predicate(last) && last }, reason, 18_000)
    } catch (error) {
      note('full-run-diagnostic', { reason, last, modelRequests:host.model.calls.length, called, workerEntered, leadReturned })
      throw error
    }
  }
  const active = await trace(a, runId, result => result.tasks?.length === 2 && result.tasks.some(t => t.waitingForChildren) && workerEntered && leadReturned, 'real message_bot handoff and early lead return')
  assert.equal(active.state, 'running')
  assert.equal((await a.cli('wait', runId, '--timeout','0')).code, 4)
  assert.equal((await g.cli('inspect', runId)).code, 2)
  assert.equal((await native.cli('inspect',runId)).code, 2)
  gate.resolve()
  const approval = await trace(a, runId, s => s.pending?.length, 'owner approval tied to the delegated work')
  assert.equal(approval.state, 'needs_input')
  assert.equal((await a.cli('wait', runId)).code, 3)
  assert.equal(tickets.calls.length, 0)
  const botPage = await host.page.context().newPage()
  try {
    // Keep the owner workbench open for its later review controls.
    await openFullTeam({ ...host, page: botPage })
    await botPage.locator('.bt-row-title').filter({ hasText: /^Full Worker$/u }).click()
    await botPage.locator('.bt-head .bt-pill-name').filter({ hasText: /^Full Worker$/u }).waitFor()
    const flow = botPage.locator('[data-chat-flow]')
    const activity = flow.locator('[data-gb-delegated-activity]').last()
    const expand = activity.getByRole('button', { name: /^执行记录(?: · \d+)?$/u })
    await expand.waitFor()
    if (await expand.getAttribute('aria-expanded') === 'false') await expand.click()
    const tool = activity.locator('details[data-gb-execution-tool]')
      .filter({ has: botPage.getByText('mcp__tickets__write', { exact: true }) })
    const running = tool.and(botPage.locator('[data-status="running"], [data-status="pending"]'))
    await running.waitFor()
    await running.locator('summary').click()
    await running.locator('pre').filter({ hasText: 'full-run' }).waitFor()
    assert.equal(await running.locator('pre').filter({ hasText: tickets.value }).count(), 0,
      'The pre-approval tool trace has inputs but not a result')
    await host.bot('approval-answer', { id: approval.pending[0].id, choice: 'allow' })
    const completed = tool.and(botPage.locator('[data-status="completed"]'))
    await completed.waitFor()
    if (!await completed.evaluate(element => element.open)) await completed.locator('summary').click()
    await completed.locator('pre').filter({ hasText: 'full-run' }).waitFor()
    await completed.locator('pre').filter({ hasText: tickets.value }).waitFor()
    await flow.getByText(childResult, { exact: true }).waitFor()
  } finally {
    await botPage.close()
  }
  const reports = await trace(a, runId, s => s.tasks?.every(t => t.status === 'reported'), 'root and delegated handoff reports')
  assert.equal(tickets.calls.length, 1)
  const original = await a.mcp('export', { runId })
  assert.ok(original.reports.some(row => row.evidence.includes(childResult)))
  const review = (runId, task, decision = 'accept') => native.owner('automation.fullReview', { runId, taskId: task.id, revision: task.evidenceRevision, decision, evidence: 'Owner fixture checked this evidence' })
  const root = reports.tasks.find(t => !t.parentTaskId)
  await review(runId, root, 'rework')
  await assert.rejects(review(runId, root), /changed/)
  const next = await trace(a, runId, s => s.tasks?.some(t => t.id === root.id && t.status === 'reported' && t.evidenceRevision === 2), 'new root report R2')
  assert.equal(next.tasks.length, 1)
  await native.access.getByRole('button', { name: '刷新 CI 状态' }).click()
  const reported = native.access.locator('section').filter({ hasText: revision })
  await reported.getByLabel('验收意见').fill('Verified R2 from the owner workbench')
  await reported.getByRole('button', { name: '提交验收' }).click()
  await trace(a, runId, s => s.state === 'completed', 'workbench accepted evidence R2')
  assert.equal((await a.cli('wait', runId, '--timeout','1')).code, 0)
  assert.ok((await a.mcp('export', {runId})).reports.some(row => row.evidence === revision))
  note('bound-bot-handoff', { runId, bot, child: to, grant: botGrant.id, approval: approval.pending[0].id, rootR1:root.evidenceRevision, latest:2, ticketCalls:tickets.calls.length })

  const roomRun = await g.mcp('run', { requestId: randomUUID(), title: 'room-fixture-' + randomUUID(), criteria: 'Return group evidence' })
  assert.ok(roomRun.runId, JSON.stringify(roomRun))
  const roomReports = await trace(g, roomRun.runId, s => s.tasks?.length >= 2 && s.tasks.every(t => t.status === 'reported'), 'group-ledger and speaker receipts')
  for (const task of roomReports.tasks) await review(roomRun.runId, task)
  assert.equal((await g.cli('wait',roomRun.runId)).code, 0)
  const exported = await g.mcp('export', { runId:roomRun.runId })
  assert.ok(exported.reports.some(r => r.evidence.includes(roomResult)))
  const book = exported.reports.find(r => r.receipt?.source === 'group-ledger').receipt
  assert.equal(book.book, 'group-' + room)
  assert.ok(!JSON.stringify(exported).includes(childResult))
  note('bound-room-ledger', { room, runId:roomRun.runId, receipt:book, speakers:roomReports.tasks.length-1 })

  const failed = (await a.cli('run','--title','fail-fixture-'+randomUUID(),'--criteria','failed receipt')).data
  await trace(a, failed.runId, s => s.state === 'failed', 'attributable failure')
  assert.equal((await a.cli('wait',failed.runId)).code, 1)
  waitForCrash = Promise.withResolvers()
  const crashed = (await a.cli('run','--title','crash-fixture-'+randomUUID(),'--criteria','reconcile before retry')).data
  await until(() => host.model.calls.some(c => JSON.stringify(c.body.messages.at(-1)).includes('crash-fixture-')), 'DSH accepted crash fixture')
  await host.stop('SIGKILL')
  waitForCrash.resolve()
  await host.start()
  assert.equal((await a.cli('wait',crashed.runId)).code, 5)
  assert.equal((await g.cli('wait',roomRun.runId)).code, 0)
  await native.owner('automation.revoke', { id:roomGrant.id })
  assert.match((await g.mcp('inspect',{runId:roomRun.runId})).error, /revoked/)
  await host.bot('delete-room', { id:room })
  await host.bot('update-bot', { id: to, private: true })
  assert.match((await a.mcp('export', { runId })).error, /accessible|bound/, 'descendant privacy excludes historical reports')
  note('full-team-recovery', { failed:failed.runId, unknown:crashed.runId, completedRoom:roomRun.runId, revoked:roomGrant.id })
}
