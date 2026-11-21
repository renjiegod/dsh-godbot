import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { saveEvidence } from '../artifacts.mjs'
import { ciTeam } from '../automation-client.mjs'
import { until } from '../host.mjs'
import { reportBotAssignments } from '../workflow-model.mjs'

const title = 'E17 scheduled editorial decision'
async function schedule(host, ci, flow) {
  const { page } = host
  await page.getByRole('navigation', { name: '团队管理导航' }).getByRole('button', { name: '自动化任务', exact: true }).click()
  const routines = page.getByRole('region', { name: '团队自动化任务' })
  await routines.getByRole('button', { name: '新建自动化任务' }).click()
  const form = page.getByRole('form', { name: '自动化任务设置' })
  await form.getByLabel('任务名称').fill(title)
  await form.getByLabel('执行类型').selectOption('workflow')
  await form.getByLabel('工作流模板').selectOption(flow.id)
  await form.getByLabel('执行频率').selectOption('once')
  const localAt = await page.evaluate(() => {
    const date = new Date(Date.now() + 6000)
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  })
  await form.getByLabel('执行时间').fill(localAt)
  await form.getByRole('button', { name: '保存任务' }).click()
  const card = routines.getByRole('article', { name: title })
  await card.waitFor()
  const routine = (await ci.owner('automation.routine.list')).routines.find(row => row.title === title)
  assert.equal(routine.workflowId, flow.id)
  assert.equal(routine.workflowRevision, flow.revision)
  const history = () => ci.owner('automation.routine.history', { id: routine.id })
  const occurrence = await until(async () => (await history()).items[0], 'scheduled workflow coming due')
  assert.equal(occurrence.trigger, 'scheduled')
  assert.equal(occurrence.dueAt, Date.parse(routine.schedule.at))
  assert.ok(occurrence.at >= occurrence.dueAt)
  assert.ok(occurrence.runId, JSON.stringify(occurrence))
  return { occurrence, card, history }
}

async function finishRun(host, ci, flow, runId, positive, receipts) {
  const current = async () => (await ci.owner('workflow.list')).runs.find(r => r.id === runId)
  const branch = positive ? 'release' : 'revise', opposite = positive ? 'revise' : 'release'
  const root = await until(async () => (await current())?.nodes.find(n => n.nodeId === 'decide' && n.status === 'reported'), 'decision awaiting owner')
  const first = receipts.get(root.taskId)
  assert.ok(first)
  for (const key of [branch, opposite]) assert.equal((await current()).nodes.find(n => n.nodeId === key).status, 'waiting')
  const approve = async taskId => {
    const task = (await host.snapshot()).tasks.find(t => t.id === taskId)
    return ci.owner('task.review', { taskId, approve: true, expectedRevision: task.revision, expectedEvidenceRevision: task.evidenceRevision })
  }
  await approve(root.taskId)
  const result = await until(async () => (await current()).nodes.find(n => n.nodeId === branch && n.status === 'reported'), 'chosen branch awaiting owner')
  const received = receipts.get(result.taskId)
  assert.ok(received.assignment.includes(first.evidence))
  await approve(result.taskId)
  const completed = await until(async () => {
    const run = await current()
    return run.status === 'completed' && run
  }, 'workflow completed through external trigger')
  assert.equal(completed.workflowId, flow.id)
  assert.equal(completed.workflowRevision, flow.revision)
  const skipped = completed.nodes.find(n => n.nodeId === opposite)
  assert.equal(skipped.status, 'skipped')
  const { messages } = await host.snapshot()
  assert.ok(!messages.some(m => m.taskId === skipped.taskId && m.kind === 'assignment'))
  const accepted = [first, received].map(receipt => {
    const report = messages.find(m => m.kind === 'report' && m.taskId === receipt.taskId)
    const ack = messages.find(m => m.kind === 'ack' && m.status === 'accepted' && m.replyTo === report.id)
    assert.equal(report.replyTo, receipt.assignmentId)
    assert.equal(report.evidence, receipt.evidence)
    assert.equal(ack.from, 'user')
    return { ...receipt, reportId: report.id, reviewId: ack.id }
  })
  return { runId, branch, skipped: opposite, accepted }
}

export default async function E17({ makeHost, candidate, note, reportDir }) {
  const host = await makeHost()
  const ci = await ciTeam(host, candidate)
  const reviewer = await ci.extra('Editorial reviewer')
  const flow = await ci.owner('workflow.save', {
    name: 'E17 controlled release',
    nodes: [
      { id: 'decide', title: 'Decide', ownerId: ci.member.id, criteria: 'Document acceptance result' },
      { id: 'release', title: 'Release', ownerId: reviewer.id, criteria: 'Return accepted result' },
      { id: 'revise', title: 'Revise', ownerId: reviewer.id, criteria: 'Return reason for revision' },
    ],
    edges: [{ from: 'decide', to: 'release', when: 'contains', value: 'APPROVED' },
      { from: 'decide', to: 'revise', when: 'not-contains', value: 'APPROVED' }],
  })
  const receipts = new Map()
  let disposition = 'APPROVED'
  reportBotAssignments(host, receipt => {
    const evidence = (receipt.title === 'Decide' ? disposition : receipt.title) + '-' + randomUUID()
    receipts.set(receipt.taskId, { ...receipt, evidence })
    return evidence
  })
  const { occurrence, card, history } = await schedule(host, ci, flow)
  const scheduled = await finishRun(host, ci, flow, occurrence.runId, true, receipts)
  await until(async () => (await history()).items.find(item => item.runId === occurrence.runId && item.state === 'completed'), 'routine records accepted workflow')
  await card.getByRole('button', { name: '运行记录' }).click()
  await card.getByText('已验收', { exact: true }).waitFor()
  await card.screenshot({ path: reportDir + '/scheduled-workflow.png' })
  await card.getByRole('button', { name: '查看工作流运行' }).click()
  const flowHistory = host.page.getByRole('region', { name: '工作流运行记录' })
  await flowHistory.getByText(occurrence.runId, { exact: true }).waitFor()
  await flowHistory.getByRole('listitem').filter({ hasText: 'Revise' }).getByText('已跳过').waitFor()
  note('wall-clock-schedule', { ...occurrence, workflowId: flow.id, closure: scheduled })

  disposition = 'NEEDS-CHANGES'
  const requestId = randomUUID()
  const submitted = await ci.cli('run', '--workflow', flow.id, '--revision', String(flow.revision), '--request-id', requestId)
  assert.equal(submitted.code, 0, JSON.stringify(submitted.data))
  const cli = await finishRun(host, ci, flow, submitted.data.runId, false, receipts)
  const replay = await ci.mcp('run_workflow', { workflowId: flow.id, revision: flow.revision, requestId })
  assert.equal(replay.runId, cli.runId, JSON.stringify(replay))
  const inspected = await ci.lookup(cli.runId, state => state.state === 'completed')
  assert.equal(inspected.workflowId, flow.id)
  assert.equal(inspected.workflowRevision, flow.revision)
  assert.deepEqual(inspected.tasks.map(task => task.workflowNodeId).sort(), ['decide', 'release', 'revise'])
  assert.equal((await ci.cli('wait', cli.runId, '--timeout', '1')).code, 0)
  const exported = await ci.mcp('export', { runId: cli.runId })
  assert.ok(exported.reports.some(r => r.evidence === cli.accepted[1].evidence), JSON.stringify(exported))
  note('installed-cli-and-mcp-replay', { workflowId: flow.id, runId: cli.runId, requestId })

  disposition = 'APPROVED'
  const mcpResult = await ci.mcp('run_workflow', { workflowId: flow.id, revision: flow.revision, requestId: randomUUID() })
  assert.ok(mcpResult.runId, JSON.stringify(mcpResult))
  const mcp = await finishRun(host, ci, flow, mcpResult.runId, true, receipts)
  const blocked = await ci.cli('run', '--workflow', flow.id, '--revision', String(flow.revision + 1), '--request-id', randomUUID())
  assert.notEqual(blocked.code, 0)
  assert.match(JSON.stringify(blocked.data), /revision changed/i)
  const actual = (await ci.owner('workflow.list')).runs
  assert.deepEqual(new Set(actual.map(run => run.id)), new Set([scheduled.runId, cli.runId, mcp.runId]))
  await saveEvidence(reportDir, 'workflow-triggers.json', { flow, occurrence, scheduled, cli, mcp, stale: blocked, replay: replay.runId })
  note('distinct-mcp-run-and-stale-rejection', { runId: mcp.runId, staleExit: blocked.code, totalRuns: actual.length })
}
