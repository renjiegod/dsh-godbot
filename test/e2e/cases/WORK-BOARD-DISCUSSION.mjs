import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
  page.on('pageerror', e => note('page-error', { message: e.message }))
  const worker = await host.bot('create-bot', { name: 'Discussion Worker', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await host.bot('chat', { botId: worker.id })).items.some(i => i.kind === 'bot'), 'worker kickoff')
  host.model.reply = () => 'Assignment evidence.'
  const draft = await channel(host, 'board-action', { op: 'create', title: 'Discussion fixture', requestId: 'create' })
  await channel(host, 'board-action', {
    id: draft.id, op: 'dispatch', owner: worker.id, criteria: 'Keep the execution receipt unique.',
    version: draft.version, requestId: 'dispatch',
  })
  const assigned = await until(async () => {
    const item = await channel(host, 'board-item', { id: draft.id })
    return item.phase === 'review' && item
  }, 'assignment evidence')
  host.model.reply = body => {
    const input = JSON.stringify(body.messages)
    return input.includes('FOLLOW_UP_BOARD') ? 'Answer to the nested reply.'
      : input.includes('LOOK_AT_BOARD') ? 'I reviewed the **attachment**.'
        : 'Other message.'
  }
  const boardUrl = host.url + '/#/godbot/work/' + draft.id
  await page.goto(boardUrl)
  const drawer = page.locator('.wb-detail')
  const criteria = drawer.getByText('Keep the execution receipt unique.', { exact: true }).first()
  await criteria.waitFor()
  const bounds = await drawer.boundingBox()
  const detailsStyle = await criteria.evaluate(node => {
    const { color, fontSize, lineHeight, backgroundColor, borderRadius } = getComputedStyle(node)
    return { color, fontSize, lineHeight, backgroundColor, borderRadius }
  })
  await drawer.screenshot({ path: join(reportDir, 'details-web.png') })
  await page.getByRole('button', { name: /^(讨论|Discussion)$/ }).click()
  assert.deepEqual(await drawer.boundingBox(), bounds, 'switching tabs keeps the same drawer geometry')
  const input = page.getByRole('textbox', { name: /^(评论|Comment)$/ })
  await input.fill('@Discussion')
  await page.getByRole('button', { name: '@Discussion Worker', exact: true }).click()
  assert.equal(await input.inputValue(), '@Discussion Worker ')
  await input.fill('@Discussion Worker LOOK_AT_BOARD')
  await page.getByText(/将唤醒 Discussion Worker|Will wake Discussion Worker/).waitFor()
  await page.locator('.wb-discussion input[type="file"]').setInputFiles({
    name: 'proof.txt', mimeType: 'text/plain', buffer: Buffer.from('proof from Web'),
  })
  await page.getByRole('button', { name: /^(发表评论|Post comment)$/ }).click()
  const read = (req = {}) => channel(host, 'board-discussion', { id: draft.id, ...req })
  const root = await until(async () => (await read()).entries.find(item => item.runs[0]?.state === 'answered'), 'Bot answer in discussion', 45000)
  assert.equal(root.runs[0].sessionId, assigned.execution.sessionId)
  assert.ok(Number.isSafeInteger(root.runs[0].turnId))
  const discussionStyle = await drawer.locator('.wb-thread').first().evaluate(node => {
    const { color, fontSize, lineHeight } = getComputedStyle(node.querySelector('.wb-comment-body p'))
    const { backgroundColor, borderRadius } = getComputedStyle(node)
    return { color, fontSize, lineHeight, backgroundColor, borderRadius }
  })
  assert.deepEqual(discussionStyle, detailsStyle, 'discussion uses the details text and surface styles')
  const thread = await read({ thread: root.id })
  assert.equal(thread.entries[0].parentId, root.id)
  assert.match(thread.entries[0].body, /reviewed the/)
  assert.equal(thread.entries[0].botId, worker.id)
  await page.getByRole('button', { name: /回复（1）|Replies \(1\)/ }).click()
  await page.getByText('I reviewed the', { exact: false }).waitFor()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'proof.txt', exact: true }).click()
  const download = await downloadPromise
  await download.saveAs(join(reportDir, 'proof.txt'))
  assert.equal(await readFile(join(reportDir, 'proof.txt'), 'utf8'), 'proof from Web')
  const botReply = page.locator('[data-board-comment="' + thread.entries[0].id + '"]')
  await botReply.getByRole('button', { name: /^(表态|React)$/ }).click()
  await botReply.getByRole('button', { name: '👍', exact: true }).click()
  await botReply.getByRole('button', { name: '👍 1' }).waitFor()
  await botReply.getByRole('button', { name: /^(回复|Reply)$/ }).click()
  await input.fill('FOLLOW_UP_BOARD')
  await page.getByRole('button', { name: /^(发送回复|Send reply)$/ }).click()
  const answered = await until(async () => {
    const current = await read({ thread: root.id })
    return current.entries.find(item => item.body === 'Answer to the nested reply.') && current
  }, 'nested Bot reply', 45000)
  const followup = answered.entries.find(item => item.body === 'FOLLOW_UP_BOARD')
  assert.equal(followup.parentId, thread.entries[0].id)
  assert.equal(followup.runs[0].sessionId, assigned.execution.sessionId)
  const final = answered.entries.find(item => item.body === 'Answer to the nested reply.')
  assert.equal(final.parentId, followup.id)
  const unchanged = await channel(host, 'board-item', { id: draft.id })
  assert.equal(unchanged.evidenceRevision, assigned.evidenceRevision)
  assert.equal(unchanged.phase, 'review')
  await drawer.screenshot({ path: join(reportDir, 'discussion-web.png') })
  await host.stop()
  await host.start()
  await page.goto(boardUrl + '/comment/' + final.id)
  await page.locator('[data-board-comment="' + final.id + '"][data-linked]').waitFor()
  assert.equal((await read({ thread: root.id })).entries.length, 3)
  await page.setViewportSize({ width: 420, height: 850 })
  assert.equal(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
  await page.screenshot({ path: join(reportDir, 'discussion-narrow.png') })
  note('work-board-discussion', {
    id: draft.id, executionConversationReused: true, sameTaskEvidence: true,
    attachmentBytesMatch: true, preservedAfterRestart: true, linkedReply: final.id,
  })
}
