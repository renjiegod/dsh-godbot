import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { saveEvidence } from '../artifacts.mjs'
import { until } from '../host.mjs'
import { openFullTeam, openTaskBoard } from '../native-ui.mjs'
import { checkWorkflowTeamTemplate } from '../workflow-template-transfer.mjs'
import { reportBotAssignments } from '../workflow-model.mjs'

const names = {
  research: 'Collect source',
  audit: 'Check scope',
  decision: 'Choose disposition',
  release: 'Prepare release',
  revise: 'Prepare revision',
  publish: 'Deliver final report',
}
const links = [
  ['research', 'decision', 'accepted'],
  ['audit', 'decision', 'accepted'],
  ['decision', 'release', 'contains', 'SHIP-OK'],
  ['decision', 'revise', 'not-contains', 'SHIP-OK'],
  ['release', 'publish', 'accepted'],
  ['revise', 'publish', 'accepted'],
]
const workflowName = 'E16 release review'
const board = page => page.getByRole('region', { name: '工作流', exact: true })
const button = (within, name) => within.getByRole('button', { name, exact: true })
const field = (within, name) => within.getByLabel(new RegExp('^' + name))
const owner = (host, action, fields) => host.rpc('godbot/dispatch', { request: { action, ...fields } })
const list = (host, teamId) => owner(host, 'workflow.list', { teamId })
const entries = value => Object.entries(value)

function fixtureModel(host, members, disposition) {
  const gate = Promise.withResolvers()
  const nonce = randomUUID()
  const calls = new Map()
  reportBotAssignments(host, async receipt => {
    const node = entries(names).find(([, name]) => name === receipt.title)?.[0]
    if (!node) return
    const evidence = node === 'decision' ? disposition + ' ' + nonce : node + '-result-' + nonce
    calls.set(node, { ...receipt, ownerId: members[node].id, evidence })
    if (node === 'research' || node === 'audit') await gate.promise
    return evidence
  })
  return { calls, gate }
}

async function createWorkflow(host, team, members) {
  const region = board(host.page)
  await openTaskBoard(host)
  await button(region, '新建工作流').click()
  await field(region, '工作流名称').fill(workflowName + ' draft')
  for (const [node, title] of entries(names)) {
    await button(region, '添加节点').click()
    await field(region, '节点名称').fill(title)
    await field(region, '负责人').selectOption(members[node].id)
    await field(region, '验收标准').fill('Attach evidence for ' + title)
    if (node === 'publish') await field(region, '汇合条件').selectOption('any')
  }
  for (const [from, to, when, value] of links) {
    await field(region, '起点').selectOption({ label: names[from] })
    await field(region, '终点').selectOption({ label: names[to] })
    await field(region, '连线条件').selectOption(when)
    if (value) await field(region, '匹配文本').fill(value)
    await button(region, '添加连线').click()
  }
  await button(region, '保存工作流').click()
  const draft = await until(async () => (await list(host, team.id)).workflows.find(w => w.name === workflowName + ' draft'), 'saved six-node draft')
  await field(region, '工作流名称').fill(workflowName)
  await button(region, '保存工作流').click()
  const saved = await until(async () => (await list(host, team.id)).workflows.find(w => w.id === draft.id && w.name === workflowName), 'saved edited graph')
  assert.equal(saved.nodes.length, 6)
  assert.equal(saved.edges.length, 6)
  assert.equal(saved.nodes.find(n => n.title === names.publish).join, 'any')
  assert.equal(saved.nodes.find(n => n.title === names.decision).join, 'all')
  for (const [key, title] of entries(names)) assert.equal(saved.nodes.find(n => n.title === title).ownerId, members[key].id)
  for (const [from, to, when, value] of links) {
    const fromId = saved.nodes.find(n => n.title === names[from]).id
    const toId = saved.nodes.find(n => n.title === names[to]).id
    assert.ok(saved.edges.some(e => e.from === fromId && e.to === toId && e.when === when && (!value || e.value === value)))
  }
  await host.page.reload()
  await openTaskBoard(host)
  await field(region, '选择工作流').selectOption(saved.id)
  await button(region, '选择节点 ' + names.publish).click()
  assert.equal(await field(region, '汇合条件').inputValue(), 'any')
  const graph = region.getByRole('group', { name: '工作流节点图' })
  await graph.screenshot({ path: join(host.reportDir, 'workflow-graph.png') })
  const originalViewport = host.page.viewportSize()
  let closedSidebar = false
  try {
    await host.page.setViewportSize({ width: 390, height: 844 })
    await until(() => graph.evaluate(el => el.clientWidth <= 390 && el.scrollWidth > el.clientWidth), 'graph scroll region fits phone width')
    const bounds = () => graph.evaluate(el => {
      const parents = []
      for (let p = el; p; p = p.parentElement) {
        const { left, right } = p.getBoundingClientRect()
        parents.push({ name: p.className || p.tagName, width: p.clientWidth, left, right })
      }
      return { width: el.clientWidth, scrollLeft: el.scrollLeft, graphRight: el.getBoundingClientRect().right, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, parents }
    })
    // DSH switches its desktop sidebar to a drawer after the resize. Wait for
    // that transition or, if the drawer stays open, close it with its control.
    const ready = await until(() => graph.evaluate(el => el.clientWidth >= 250 && el.getBoundingClientRect().right <= innerWidth + 1), 'DSH mobile drawer transition', 5000).catch(() => false)
    if (!ready && await button(host.page, '收起侧栏').isVisible()) {
      await button(host.page, '收起侧栏').click()
      closedSidebar = true
    }
    await until(() => graph.evaluate(el => el.clientWidth >= 250 && el.getBoundingClientRect().right <= innerWidth + 1), 'mobile graph gets a readable width')
    await graph.evaluate(el => { el.scrollLeft = el.scrollWidth })
    const geometry = await bounds()
    await saveEvidence(host.reportDir, 'phone-geometry.json', geometry)
    assert.ok(geometry.graphRight <= geometry.viewport + 1, JSON.stringify(geometry))
    assert.ok(geometry.pageWidth <= geometry.viewport + 1, JSON.stringify(geometry))
    assert.ok(geometry.scrollLeft > 0)
    await button(region, '选择节点 ' + names.publish).click()
    await graph.screenshot({ path: join(host.reportDir, 'workflow-graph-phone.png') })
  } finally {
    await host.page.setViewportSize(originalViewport)
    if (closedSidebar) await button(host.page, '展开侧栏').first().click()
  }
  await host.capture('edited-workflow')
  return saved
}

async function accept(host, memberCall) {
  const { taskId, assignmentId, evidence, ownerId } = memberCall
  const task = await until(async () => (await host.snapshot()).tasks.find(t => t.id === taskId && t.status === 'reported'), 'native report ' + taskId)
  assert.equal(task.ownerId, ownerId)
  assert.equal(task.assignmentId, assignmentId)
  assert.equal(task.evidence, evidence)
  const card = host.page.locator('#gb-task-' + taskId)
  await button(card, '验收任务').click()
  await field(card, '证据或验收意见').fill('Owner checked ' + taskId)
  await button(card, '验收通过').click()
  await until(async () => (await host.snapshot()).tasks.find(t => t.id === taskId && t.status === 'completed'), 'owner accepted ' + taskId)
}

async function runWorkflow(host, team, template, members, disposition, note) {
  const region = board(host.page)
  const before = new Set((await list(host, team.id)).runs.map(r => r.id))
  const { gate, calls } = fixtureModel(host, members, disposition)
  const chosen = disposition === 'SHIP-OK' ? 'release' : 'revise'
  const other = chosen === 'release' ? 'revise' : 'release'
  await button(region, '运行工作流').click()
  const run = await until(async () => (await list(host, team.id)).runs.find(r => !before.has(r.id)), 'new workflow run')
  const state = async () => (await list(host, team.id)).runs.find(r => r.id === run.id)
  const node = (r, key) => r.nodes.find(n => n.nodeId === template.nodes.find(t => t.title === names[key]).id)
  try {
    // Both provider requests must arrive while neither is allowed to finish.
    await until(() => calls.has('research') && calls.has('audit'), 'both parallel model requests')
    for (const key of ['research', 'audit']) assert.equal(calls.get(key).sessionId, members[key].sessionId ?? members[key].id)
    assert.notEqual(calls.get('research').sessionId, calls.get('audit').sessionId)
    assert.ok(!calls.has('decision'))
  } finally { gate.resolve() }
  await accept(host, calls.get('research'))
  const waiting = await state()
  assert.equal(node(waiting, 'decision').status, 'waiting')
  assert.ok(!calls.has('decision'))
  await accept(host, calls.get('audit'))
  const decide = await until(() => calls.get('decision'), 'first fan-in delivery')
  for (const upstream of ['research', 'audit']) assert.ok(decide.assignment.includes(calls.get(upstream).evidence))
  await until(async () => (await host.snapshot()).tasks.find(t => t.id === decide.taskId && t.status === 'reported'), 'decision awaits owner review')
  for (const target of [chosen, other]) assert.equal(node(await state(), target).status, 'waiting')
  await accept(host, decide)
  const routed = await until(() => calls.get(chosen), 'matching conditional edge')
  assert.ok(routed.assignment.includes(decide.evidence))
  await accept(host, routed)
  const publish = await until(() => calls.get('publish'), 'any matching branch reaches delivery')
  assert.ok(publish.assignment.includes(routed.evidence))
  assert.ok(!calls.has(other))
  await accept(host, publish)
  const completed = await until(async () => {
    const r = await state()
    return r.status === 'completed' && r
  }, 'end-to-end workflow completion')
  assert.equal(node(completed, other).status, 'skipped')
  assert.equal(calls.size, 5)
  const snapshot = await host.snapshot()
  const skipped = node(completed, other)
  assert.ok(!snapshot.messages.some(m => m.taskId === skipped.taskId && m.kind === 'assignment'))
  assert.ok(!snapshot.tasks.find(t => t.id === skipped.taskId).assignmentId)
  for (const [key, receipt] of calls) {
    assert.equal(node(completed, key).taskId, receipt.taskId)
    const delivery = snapshot.messages.find(m => m.id === receipt.assignmentId)
    assert.equal(delivery.kind, 'assignment')
    assert.deepEqual(delivery.to, [receipt.ownerId])
    assert.equal(delivery.taskId, receipt.taskId)
    const task = snapshot.tasks.find(t => t.id === receipt.taskId)
    const report = snapshot.messages.find(m => m.id === task.reportMessageId)
    const review = snapshot.messages.find(m => m.id === task.reviewMessageId)
    assert.equal(report.from, task.ownerId)
    assert.equal(report.replyTo, delivery.id)
    assert.equal(report.evidence, receipt.evidence)
    assert.equal(review.from, 'user')
    assert.equal(review.replyTo, report.id)
    assert.equal(review.status, 'accepted')
    assert.equal(review.evidenceRevision, report.evidenceRevision)
    Object.assign(receipt, { reportId: report.id, reviewId: review.id, acceptedRevision: review.evidenceRevision })
  }
  const history = region.getByRole('region', { name: '工作流运行记录' })
  await until(async () => (await history.getByRole('listitem').filter({ hasText: '已完成' }).count()) === calls.size &&
    await history.getByRole('listitem').filter({ hasText: '已跳过' }).count() === 1, 'completed and skipped nodes rendered')
  await history.screenshot({ path: join(host.reportDir, 'history-' + chosen + '.png') })
  await history.scrollIntoViewIfNeeded()
  await host.capture('completed-' + chosen)
  const result = { runId: run.id, workflowId: template.id, disposition, skipped: other, nodes: completed.nodes, receipts: Object.fromEntries(calls) }
  note('workflow-run', { runId: run.id, disposition, skipped: other, acceptedTasks: [...calls.values()].map(record => record.taskId) })
  return result
}

async function roundTrip(host, team, template) {
  const region = board(host.page)
  const download = host.page.waitForEvent('download')
  await button(region, '导出工作流模板').click()
  const file = join(host.root, 'workflow-template.json')
  await (await download).saveAs(file)
  const raw = await readFile(file, 'utf8')
  assert.ok(!raw.includes(template.id))
  assert.ok(!raw.includes(team.id))
  for (const n of template.nodes) assert.ok(!raw.includes(n.ownerId))
  await field(region, '导入工作流模板').setInputFiles(file)
  await button(region, '保存导入的工作流').click()
  const copy = await until(async () => (await list(host, team.id)).workflows.find(w => w.id !== template.id && w.name === template.name), 'portable graph imported independently')
  assert.deepEqual(copy.nodes.map(n => [n.title, n.ownerId, n.join, n.criteria]), template.nodes.map(n => [n.title, n.ownerId, n.join, n.criteria]))
  const labelled = graph => graph.edges.map(e => [
    graph.nodes.find(n => n.id === e.from).title,
    graph.nodes.find(n => n.id === e.to).title,
    e.when,
    e.value ?? '',
  ])
  assert.deepEqual(labelled(copy), labelled(template))
  const { runs } = await list(host, team.id)
  assert.equal(runs.length, 2)
  return copy.id
}

export default async function E16({ makeHost, candidate, note, reportDir }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  const godbotId = await openFullTeam(host)
  const team = { id: 'godbot-workspace' }
  const model = 'deepseek-official/deepseek-flash'
  await host.bot('update-bot', { id: godbotId, model })
  const member = (await host.bot('state')).bots.find(bot => bot.id === godbotId)
  const separateDirectory = join(host.root, 'reviewer-work')
  await mkdir(separateDirectory)
  const reviewer = await host.bot('create-bot', { name: 'Review analyst', model, workDir: separateDirectory })
  assert.notEqual(reviewer.id, member.id)
  const members = { research: member, audit: reviewer, decision: member, release: reviewer, revise: reviewer, publish: member }
  const template = await createWorkflow(host, team, members)
  const one = await runWorkflow(host, team, template, members, 'SHIP-OK', note)
  const two = await runWorkflow(host, team, template, members, 'HOLD', note)
  assert.notEqual(one.runId, two.runId)
  const earlierIds = new Set(Object.values(one.receipts).map(task => task.taskId))
  for (const task of Object.values(two.receipts)) assert.ok(!earlierIds.has(task.taskId))
  assert.ok(!two.receipts.decision.assignment.includes(one.receipts.research.evidence))
  const copyId = await roundTrip(host, team, template)
  const route = new URL(host.page.url()).hash
  await host.restart()
  const persisted = await list(host, team.id)
  assert.deepEqual(new Set(persisted.workflows.map(w => w.id)), new Set([copyId, template.id]))
  assert.deepEqual(new Set(persisted.runs.filter(r => r.status === 'completed').map(r => r.id)), new Set([one.runId, two.runId]))
  await host.page.goto(host.url + '/' + route)
  await openTaskBoard(host)
  const region = board(host.page)
  await field(region, '选择工作流').selectOption(template.id)
  await field(region, '选择运行记录').selectOption(one.runId)
  await region.getByRole('listitem').filter({ hasText: names.revise }).getByText('已跳过').waitFor()
  const newTitle = 'Rewrite the release notes'
  await button(region, '选择节点 ' + names.revise).click()
  await field(region, '节点名称').fill(newTitle)
  await button(region, '保存工作流').click()
  await until(async () => (await list(host, team.id)).workflows.find(w => w.id === template.id && w.revision > template.revision && w.nodes.some(n => n.title === newTitle)), 'new live definition stored')
  await field(region, '选择运行记录').selectOption(one.runId)
  await region.getByText('本次运行的流程图', { exact: true }).click()
  const historic = region.getByRole('group', { name: '本次运行的节点图' })
  await button(historic, '查看节点任务 ' + names.revise + ' · 已跳过').waitFor()
  assert.equal(await historic.getByText(newTitle).count(), 0)
  await button(region, '选择节点 ' + newTitle).waitFor()
  await historic.screenshot({ path: join(reportDir, 'historical-workflow.png') })
  await saveEvidence(reportDir, 'workflow-receipts.json', { template, runs: [one, two], imported: copyId })
  note('roundtrip-and-restart', { workflowId: template.id, imported: copyId, runs: [one.runId, two.runId] })
  await checkWorkflowTeamTemplate(host, team, template, note)
}
