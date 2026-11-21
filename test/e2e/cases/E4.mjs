import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ticketEnvironment } from '../tickets.mjs'
import { ciTeam } from '../automation-client.mjs'

export default context => acceptedJourney(context, 'cli')

export async function acceptedJourney(context, origin) {
  const { host, tickets } = await ticketEnvironment(context, { approval: true })
  try { await runJourney(host, tickets, context.note, origin) } finally { await tickets.close() }
}

async function runJourney(host, tickets, note, origin) {
  const ci = await ciTeam(host)
  const reviewer = await ci.extra('Reviewer')
  const title = 'Review build ' + randomUUID()
  const criteria = 'Supply the connector receipt'
  const marker = randomUUID(), requestId = randomUUID()
  const sent = new Set()
  const evidence = n => 'Review ' + n + ' · ' + tickets.value
  host.model.reply = body => {
    const assignment = (body.messages ?? []).findLast(m => m.role === 'user' && JSON.stringify(m.content).includes(title))
    if (!assignment) return 'Acknowledged'
    const attempt = JSON.stringify(assignment.content).includes('Rework:') ? 2 : 1
    if (sent.has(attempt)) return evidence(attempt)
    sent.add(attempt)
    const name = attempt === 1 ? 'mcp__tickets__write' : 'mcp__tickets__read'
    assert.ok(body.tools?.some(tool => tool.name === name))
    return [{ type: 'tool_use', name, input: { query: { id: marker } } }]
  }

  let runId
  if (origin === 'webhook') {
    const hook = await ci.owner('automation.hook', { ownerId: reviewer.id, title, criteria, label: 'Review builds' })
    const body = JSON.stringify({ commit: randomUUID() })
    const signature = createHmac('sha256', hook.secret).update(requestId).update('\n').update(body).digest('hex')
    const send = async () => {
      const response = await fetch(hook.url, { method: 'POST', body,
        headers: { 'x-godbot-delivery': requestId, 'x-godbot-signature': signature } })
      assert.equal(response.status, 202)
      return response.json()
    }
    const [first, repeated] = await Promise.all([send(), send()])
    assert.deepEqual(first, repeated)
    runId = first.runId
  } else {
    const receipt = await ci.cli('run', '--bot', reviewer.id, '--title', title, '--criteria', criteria, '--request-id', requestId)
    assert.equal(receipt.code, 0, JSON.stringify(receipt.data))
    runId = receipt.data.runId
    assert.equal((await ci.mcp('run', { ownerId: reviewer.id, title, criteria, requestId })).runId, runId)
  }
  const approval = await ci.lookup(runId, row => row.pending.some(item => item.type === 'permission'))
  assert.equal((await ci.cli('wait', runId)).code, 3)
  assert.equal(tickets.calls.length, 0)
  await host.bot('approval-answer', { id: approval.pending[0].id, choice: 'allow' })
  const reported = n => ci.lookup(runId, view => view.tasks.some(task => task.status === 'reported' && task.evidenceRevision === n))
  for (const n of [1, 2]) {
    const view = await reported(n)
    const task = view.tasks[0]
    assert.equal(task.ownerId, reviewer.id)
    await ci.owner('task.review', { taskId: task.id, approve: n === 2, evidence: n === 2 ? 'Accepted' : 'Read back the saved ticket',
      expectedRevision: task.revision, expectedEvidenceRevision: n })
  }
  assert.equal((await ci.cli('wait', runId, '--timeout', '25')).code, 0)
  const file = join(host.root, 'evidence.json')
  const exported = await ci.cli('export', runId, '--output', file)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), exported.data)
  for (const n of [1, 2]) assert.ok(exported.data.reports.some(row => row.evidence === evidence(n) && row.revision === n))
  assert.deepEqual(tickets.calls.map(c => [c.name, c.input.query.id]), [['write', marker], ['read', marker]])
  assert.equal((await ci.mcp('inspect', { runId })).state, 'completed')
  const actual = await host.bot('chat', { botId: reviewer.id })
  const reworkCalls = host.model.calls.filter(call => JSON.stringify(call.body.messages).includes('Rework: Read back the saved ticket'))
  assert.ok(reworkCalls.length && reworkCalls.every(call => call.sessionId === actual.sessionId),
    'The selected Bot’s existing DSH private session performed the revision')
  note('workspace-bot-review', { origin, runId, botId: reviewer.id, revisions: [1, 2], connectorCalls: tickets.calls.length })
}
