import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { until } from '../host.mjs'

export async function channel(host, endpoint, payload = {}) {
  const r = await host.page
    .context()
    .request.post(host.url + '/api/godbot/team', { data: { endpoint, payload }, headers: { Origin: host.url } })
  const frame = await r.json()
  if (!frame.ok) throw new Error(frame.error?.message ?? 'Work board request failed')
  return frame.value
}
export default async function check({ makeHost, candidate, previous, note }) {
  const host = await makeHost()
  const fixture = new URL('../../external/fixtures/fake-claude.mjs', import.meta.url)
  const cli = [
    '#!/usr/bin/env node',
    'if(process.argv.includes("--version"))console.log("2.1.331");',
    'else if(process.argv.includes("status"))console.log(JSON.stringify({loggedIn:true}));',
    'else await import(' + JSON.stringify(fixture.href) + ');',
  ].join('\n')
  await writeFile(join(host.bin, 'claude'), cli, { mode: 0o700 })
  let oldTask
  if (previous) {
    await host.install(previous)
    await host.start()
    await openFullTeam(host)
    const team = await host.bot('state')
    oldTask = await host.rpc('dispatch', {
      request: {
        action: 'task.create',
        teamId: 'godbot-workspace',
        ownerId: team.mainBotId,
        title: 'Earlier work',
        criteria: 'Upgrade can read this record',
        requestId: 'previous-board-task',
      },
    })
    await host.stop()
  }
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const { page } = host
  page.on('pageerror', (e) => note('browser-error', { message: e.message.slice(0, 500) }))
  page.on('response', async (response) => {
    if (!response.url().endsWith('/api/godbot/team')) return
    const request = response.request().postDataJSON()
    if (request?.endpoint !== 'board-action') return
    const value = await response.json().catch(() => null)
    note('board-action', {
      op: request.payload.op,
      id: value?.value?.id,
      mark: value?.value?.mark,
      error: value?.error?.message,
    })
  })
  const team = await host.bot('state')
  const model = await host.bot('create-bot', { name: 'Board verifier', model: 'deepseek-official/deepseek-flash' })
  await until(
    async () => (await host.bot('chat', { botId: model.id })).items.some((i) => i.kind === 'bot'),
    'fixture Bot is active',
  )
  host.model.reply = () => 'First evidence for the board test'
  const board = () => channel(host, 'board-view'),
    item = (id) => channel(host, 'board-item', { id })
  if (oldTask) assert.equal((await channel(host, 'board-item', { taskId: oldTask.id })).title, 'Earlier work')
  const start = performance.now()
  await page
    .getByRole('button', { name: /^(工作看板|Work board)$/ })
    .first()
    .click()
  const shell = page.locator('.wb-shell')
  await shell.locator('.wb-lane').first().waitFor()
  const firstPaintMs = Math.round(performance.now() - start)
  await shell.getByRole('button', { name: /^(新建工作项|New work item)$/ }).click()
  await shell.locator('form input').fill('Board round trip')
  await shell.getByRole('button', { name: /^(确认|Confirm)$/ }).click()
  const draft = await until(
    async () => (await board()).columns.flatMap((c) => c.items).find((c) => c.title === 'Board round trip'),
    'draft persisted',
  )
  assert.equal(draft.mark, 'draft')
  await shell.getByRole('button', { name: /^(派给 Bot|Assign to Bot)$/ }).click()
  await shell.locator('form select').first().selectOption(model.id)
  await shell.locator('form textarea').fill('Both attempts and the original evidence are retained')
  await shell.getByRole('button', { name: /^(确认|Confirm)$/ }).click()
  const first = await until(
    async () => {
      const d = await item(draft.id)
      return d.phase === 'review' && d
    },
    'attributed first report',
    60000,
  )
  assert.equal(first.evidenceRevision, 1)
  assert.notEqual(first.execution.sessionId, model.id)
  host.model.reply = () => 'Revised evidence for the board test'
  await shell.getByRole('button', { name: /^(退回修改|Request changes)$/ }).click()
  await shell.locator('form textarea').fill('Provide additional evidence')
  await shell.getByRole('button', { name: /^(确认|Confirm)$/ }).click()
  const revised = await until(
    async () => {
      const d = await item(draft.id)
      return d.evidenceRevision === 2 && d.phase === 'review' && d
    },
    'second evidence',
    60000,
  )
  assert.equal(revised.execution.sessionId, first.execution.sessionId)
  await assert.rejects(
    channel(host, 'board-action', {
      id: draft.id,
      op: 'approve',
      requestId: 'stale-review',
      version: first.version,
      evidenceRevision: 1,
    }),
  )
  await shell.getByRole('button', { name: /^(验收通过|Accept evidence)$/ }).click()
  await shell.getByRole('button', { name: /^(确认|Confirm)$/ }).click()
  const done = await until(async () => {
    const d = await item(draft.id)
    return d.phase === 'done' && d
  }, 'approved from Web')
  assert.equal(done.events.filter((e) => e.kind === 'report').length, 2)
  await host.capture('web-work-board-evidence')
  await page.goto(host.url + '/#/godbot/work/' + draft.id)
  await page.locator('.wb-detail').getByText('Board round trip', { exact: true }).waitFor()
  for (const width of [1440, 1024, 390, 360]) {
    await page.setViewportSize({ width, height: 850 })
    assert.ok(
      await page.locator('.wb-detail').evaluate((el) => el.getBoundingClientRect().right <= innerWidth + 1),
    )
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await host.restart()
  assert.equal((await item(draft.id)).phase, 'done')
  assert.equal(
    (await host.bot('board-view')).counts.all,
    (await board()).counts.all,
    'the authenticated owner RPC and Web read the same board',
  )
  await openFullTeam(host)
  await openBotChat(host, model)
  const message = 'Capture this source message in the board'
  await host.bot('send', {
    sessionId: model.id,
    requestId: 'board-source-message',
    text: message,
  })
  const bubble = page.locator('.bt-umsg').filter({ hasText: message }).last()
  await bubble.hover()
  const convert = bubble.getByRole('button', { name: /从消息建工作项|Create work item from message/ })
  await convert.click()
  assert.equal(await page.locator('.wb-editor input').inputValue(), message)
  await page.locator('.wb-editor button[type=submit]').click()
  const linked = await until(
    async () => (await board()).columns.flatMap((c) => c.items).find((c) => c.title === message),
    'message conversion created a card',
  )
  const source = await item(linked.id)
  assert.ok(source.origin?.messageId)
  assert.equal(source.origin.botId, model.id)
  await shell.getByRole('button', { name: /^打开发起会话$|^Open source conversation$/ }).click()
  await shell.locator('.wb-detail pre').filter({ hasText: message }).first().waitFor()
  const same = await channel(host, 'board-action', {
    op: 'create',
    title: 'Reopen the source',
    origin: source.origin,
    requestId: 'same-message',
  })
  assert.equal(same.id, linked.id)
  await shell.locator('.wb-detail header button').click()
  await shell.locator('.wb-detail header button').click()
  await shell.getByRole('button', { name: /Close work board|关闭工作看板/ }).click()
  const group = await host.bot('create-room', {
    name: 'Board group',
    members: [team.mainBotId, model.id],
    admin: team.mainBotId,
  })
  await page.locator('[data-room-id="' + group.id + '"]').click()
  const groupText = 'Group work should stay linked to this message'
  await host.bot('send', { sessionId: group.id, text: groupText })
  const groupBubble = page.locator('.bt-umsg').filter({ hasText: groupText }).last()
  await groupBubble.hover()
  await groupBubble.getByRole('button', { name: /从消息建工作项|Create work item from message/ }).click()
  await page.locator('.wb-editor button[type=submit]').click()
  const groupCard = await until(
    async () => (await board()).columns.flatMap((c) => c.items).find((c) => c.title === groupText),
    'group message on the same board',
  )
  assert.equal((await item(groupCard.id)).origin.roomId, group.id)
  const local = await host.bot('create-bot', { name: 'Board CLI', model: 'local-claude-code/default' })
  await until(
    async () => (await host.bot('chat', { botId: local.id })).items.some((i) => i.kind === 'bot'),
    'external CLI greeting',
    60000,
  )
  const localDraft = await channel(host, 'board-action', {
    op: 'create',
    title: 'CLI board receipt',
    owner: local.id,
    criteria: 'Return fixture evidence',
    requestId: 'cli-draft',
  })
  await channel(host, 'board-action', {
    op: 'dispatch',
    id: localDraft.id,
    version: localDraft.version,
    requestId: 'cli-send',
  })
  const localReport = await until(
    async () => {
      const d = await item(localDraft.id)
      return d.phase === 'review' && d
    },
    'external CLI assignment receipt',
    60000,
  )
  assert.equal(localReport.owner, local.id)
  assert.ok(localReport.evidence)
  assert.notEqual(localReport.execution.sessionId, model.id)
  if (previous) {
    await host.stop()
    await host.install(previous)
    await host.start()
    const original = await host.rpc('dispatch', { request: { action: 'team-workspace.management' } })
    assert.equal(original.tasks.find((t) => t.id === done.taskId)?.status, 'completed')
    await host.stop()
    await host.install(candidate)
    await host.start()
    assert.equal((await item(linked.id)).mark, 'draft')
  }
  note('board-round-trip', {
    id: draft.id,
    team: team.mainBotId,
    upgraded: !!oldTask,
    rollback: !!previous,
    sourceMessage: source.origin.messageId,
    firstPaintMs,
    attempts: done.attempt,
    evidenceRevision: done.evidenceRevision,
    staleRejected: true,
    restart: true,
  })
}
