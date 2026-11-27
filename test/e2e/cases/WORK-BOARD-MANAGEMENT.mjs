import assert from 'node:assert/strict'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { channel } from './WORK-BOARD.mjs'

export default async function check({ makeHost, candidate, reportDir, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const { page } = host
  page.on('pageerror', error => note('page-error', { message: error.message }))
  const bot = await host.bot('create-bot', { name: 'Board acceptance', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'Bot ready')
  const value = (verb, req) => channel(host, verb, req)
  let sequence = 0
  const act = (op, req = {}, item) => value('board-action', {
    op, id: item?.id, version: item?.version, requestId: 'management-' + sequence++, ...req,
  })
  const read = id => value('board-item', { id })
  const runList = id => value('board-runs', { id })
  const discuss = (id, op, req) => value('board-comment', { id, op, requestId: 'discussion-' + sequence++, ...req })

  const property = await act('configure', { entry: { kind: 'property', name: 'Severity', propertyType: 'select', options: ['Major', 'Minor'] } })
  await page.goto(host.url + '/#/godbot/work')
  const board = page.locator('.wb-shell')
  await board.getByRole('button', { name: /^(新建工作项|New work item)$/ }).click()
  let editor = board.locator('.wb-editor')
  await editor.getByRole('textbox', { name: /^(标题|Title)$/ }).fill('Release verification')
  await editor.getByRole('textbox', { name: /^(任务描述|Task description)$/ }).fill('Hosted release requirements')
  await editor.getByRole('textbox', { name: /^(标签|Labels)$/ }).fill('release, unassigned')
  await editor.getByLabel(/^(截止日期|Due date)$/).fill('2026-12-15')
  await editor.getByLabel('Severity').selectOption('Major')
  await editor.getByRole('button', { name: /^(确认|Confirm)$/ }).click()
  const parent = await until(async () => (await value('board-view', { search: 'Hosted release requirements' }))
    .columns.flatMap(column => column.items).find(card => card.title === 'Release verification'), 'saved card')
  assert.equal((await read(parent.id)).fields.customValues[property.id], 'Major')
  await board.getByRole('button', { name: /^(新建子任务|New subtask)$/ }).click()
  editor = board.locator('.wb-editor')
  await editor.getByRole('textbox', { name: /^(标题|Title)$/ }).fill('Build receipt')
  await editor.getByRole('button', { name: /^(确认|Confirm)$/ }).click()
  const child = await until(async () => (await read(parent.id)).planning.children[0], 'subtask attached')
  await board.getByRole('button', { name: /^(标记完成|Mark complete)$/ }).click()
  await board.locator('.wb-editor').getByRole('button', { name: /^(确认|Confirm)$/ }).click()
  await until(async () => (await read(child.id)).phase === 'done', 'manual child completed')
  assert.equal((await read(parent.id)).planning.progress.completed, 1)

  const file = bytes => [{ name: 'verification.txt', mime: 'text/plain', data: Buffer.from(bytes).toString('base64') }]
  const root = await discuss(parent.id, 'post', { body: 'Current checksum', files: file('Version 1'), quiet: true })
  const answer = await discuss(parent.id, 'post', {
    parentId: root.commentId, body: 'Final checksum', files: file('Version 2'), quiet: true,
    annotations: [{ commentId: root.commentId, start: 0, end: 7, quote: 'Current', note: 'This value is superseded.' }],
  })
  await discuss(parent.id, 'resolve', { commentId: root.commentId, conclusionId: answer.commentId, resolved: true })
  const fromComment = await act('create', { title: 'Document the checksum', parent: parent.id, commentId: answer.commentId })
  assert.equal(fromComment.planning.snapshot.context.comments.length, 2)
  await page.goto(host.url + '/#/godbot/work/' + parent.id)
  await board.getByRole('button', { name: /^(交付文件|Artifacts)$/ }).click()
  await board.getByText(/verification\.txt · v2/).waitFor()
  await page.screenshot({ path: join(reportDir, 'artifact-versions.png') })

  const saved = await act('configure', { entry: {
    kind: 'view', name: 'Release timeline', visibility: 'shared',
    filters: { label: 'unassigned', sort: 'dueDate' }, display: { layout: 'gantt', groupBy: 'phase' },
  } })
  await page.goto(host.url + '/#/godbot/work/view/' + saved.id)
  await board.locator('.wb-timeline-track').getByRole('button', { name: parent.id }).waitFor()
  await page.screenshot({ path: join(reportDir, 'timeline.png') })
  const bulk = await act('bulk', { items: [{ id: parent.id, version: (await read(parent.id)).version }],
    patch: { addLabels: ['ship-ready'], priority: 2 } })
  assert.deepEqual(bulk.applied, [parent.id])
  const hits = await value('board-view', { search: 'Final checksum', label: 'ship-ready' })
  assert.equal(hits.counts.all, 1)

  let release, hold = true
  const gate = new Promise(resolve => { release = resolve })
  host.model.reply = async body => {
    const messages = JSON.stringify(body.messages)
    if (messages.includes('CONTROL_WORK_BOARD')) {
      if (hold) await gate
      if (!messages.includes('Recorded proof from work_progress')) return [{
        type: 'tool_use', name: 'work_progress', input: { text: 'Recorded proof from work_progress', blocked: false },
      }]
      return 'Retry produced an attributable receipt.'
    }
    return 'Ready.'
  }
  try {
    const work = await act('create', { title: 'CONTROL_WORK_BOARD', owner: bot.id, criteria: 'Return progress and proof' })
    await act('dispatch', {}, work)
    const active = await until(async () => (await runList(work.id)).runs.find(run => run.status === 'running' && Number.isSafeInteger(run.turnId)), 'exact run is active')
    await page.goto(host.url + '/#/godbot/work/' + work.id)
    await board.getByRole('button', { name: /^(运行|Runs)$/ }).click()
    await board.getByRole('button', { name: /Board acceptance ·/ }).first().click()
    const stop = board.getByRole('button', { name: /^(停止本次运行|Stop this run)$/ })
    await stop.click()
    await board.locator('.wb-run-panel').getByRole('button', { name: /^(确认|Confirm)$/ }).click()
    await until(async () => (await read(work.id)).phase === 'attention', 'specific run stopped')
    hold = false
    release()
    const stopped = (await runList(work.id)).runs.find(run => run.id === active.id)
    assert.ok(['stopped', 'interrupted'].includes(stopped.status), stopped.status)
    await act('run-retry', { runId: active.id }, await read(work.id))
    await until(async () => (await read(work.id)).phase === 'review', 'retried run produced proof')
    const runs = (await runList(work.id)).runs
    assert.equal(runs.length, 2)
    assert.equal(runs[0].sessionId, active.sessionId)
    const log = await value('board-runs', { id: work.id, runId: runs[0].id })
    assert.ok(log.events.some(event => event.type === 'tool' && event.name === 'work_progress'))
    assert.ok(log.events.some(event => event.type === 'text' && event.text.includes('attributable receipt')))
    note('board-management', { card: parent.id, child: child.id, runCount: runs.length, stopped: stopped.status })
  } finally { release() }

  let unblock
  const blockerGate = new Promise(resolve => { unblock = resolve })
  host.model.reply = async body => {
    const messages = JSON.stringify(body.messages)
    if (messages.includes('HOLD_BOARD_ASSIGNMENTS')) await blockerGate
    if (messages.includes('Queued board assignment')) {
      return messages.includes('Acceptance criteria: Revised receipt') && !messages.includes('Acceptance criteria: Original receipt')
        ? 'Proof for the revised requirements.' : 'Received a stale assignment.'
    }
    return 'Queue unblocked.'
  }
  try {
    const blocker = await act('create', { title: 'HOLD_BOARD_ASSIGNMENTS', owner: bot.id, criteria: 'Hold this Bot temporarily' })
    await act('dispatch', {}, blocker)
    await until(async () => (await runList(blocker.id)).runs.some(run => run.status === 'running'), 'first assignment running')
    const waiting = await act('create', { title: 'Queued board assignment', owner: bot.id, criteria: 'Original receipt' })
    const dispatched = await act('dispatch', {}, waiting)
    const [queued] = (await runList(waiting.id)).runs
    assert.equal(queued.status, 'queued')
    await act('edit-fields', { criteria: 'Revised receipt', reason: 'Update scope before delivery' }, dispatched)
    unblock()
    const result = await until(async () => {
      const card = await read(waiting.id)
      return card.phase === 'review' && card
    }, 'the queued Bot reports')
    assert.match(result.evidence, /Proof for the revised requirements/)
    assert.ok(result.actions.includes('approve'))
    assert.equal((await runList(waiting.id)).runs[0].id, queued.id)
    note('queued-assignment', { card: waiting.id, run: queued.id, latestRequirements: true })
  } finally { unblock() }
}
