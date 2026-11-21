import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { EnvironmentError, until } from './host.mjs'
import { installLiveCli } from './live-cli.mjs'
import { openManagement } from './native-ui.mjs'

async function accountFolder(name) {
  const path = process.env[name]
  if (!path) return undefined
  const folder = isAbsolute(path) && await realpath(path).catch(() => undefined)
  if (!folder || !(await stat(folder)).isDirectory()) throw new EnvironmentError(name + ' must name an existing CLI profile directory')
  return folder
}

export default async function liveBotWorkflow({ makeHost, candidate, note }) {
  const claudeProfile = await accountFolder('GODBOT_E2E_CLAUDE_CONFIG_DIR')
  const codexProfile = await accountFolder('GODBOT_E2E_CODEX_HOME')
  const host = await makeHost()
  const claude = await installLiveCli(host, 'claude', { profileDir: claudeProfile })
  const codex = await installLiveCli(host, 'codex', { profileDir: codexProfile })
  host.model.reply = () => ({ failure: { status: 400, message: 'The live workflow uses the registered CLI backends.' } })
  await host.install(candidate)
  await host.start()
  const create = (name, route) => host.bot('create-bot', { name, model: route + '/default', workDir: host.workspace,
    role: 'Perform the assigned mental arithmetic and reply with the requested single line. No tools.' })
  const first = await create('Workflow Sum', 'local-claude-code')
  const second = await create('Workflow Product', 'local-codex-cli')
  const dispatch = (action, fields = {}) => host.rpc('dispatch', { request: { action, ...fields } })
  const marker = randomUUID().slice(0, 8), a = randomInt(13, 49), b = randomInt(3, 10)
  const flow = await dispatch('workflow.save', {
    name: 'CLI calculation ' + marker,
    nodes: [
      { id: 'sum', title: 'Add the numbers', ownerId: first.id,
        criteria: `Add ${a} and ${b}. Reply exactly SUM-${marker}=<sum>, replacing <sum> with decimal digits.` },
      { id: 'product', title: 'Verify the sum', ownerId: second.id,
        criteria: `Multiply the accepted SUM by ${b}. Reply exactly PRODUCT-${marker}=<result> with decimal digits.` },
    ],
    edges: [{ from: 'sum', to: 'product', when: 'accepted' }],
    requestId: randomUUID(),
  })
  await openManagement(host)
  const readyAt = new Date(Date.now() + 6500).toISOString()
  const scheduled = await dispatch('automation.routine.create', { requestId: randomUUID(), target: 'workflow',
    title: flow.name, workflowId: flow.id, workflowRevision: flow.revision, schedule: { kind: 'once', at: readyAt } })
  const history = () => dispatch('automation.routine.history', { id: scheduled.id })
  const occurrence = await until(async () => (await history()).items[0], 'workflow schedule fired', 30_000)
  assert.equal(occurrence.trigger, 'scheduled')
  assert.equal(occurrence.dueAt, Date.parse(readyAt))
  assert.ok(occurrence.runId && occurrence.at >= occurrence.dueAt)
  const run = async () => (await dispatch('workflow.list')).runs.find(row => row.id === occurrence.runId)
  for (const [node, bot, expected] of [
    ['sum', first, `SUM-${marker}=${a + b}`],
    ['product', second, `PRODUCT-${marker}=${(a + b) * b}`],
  ]) {
    const result = await until(async () => (await run()).nodes.find(n => n.nodeId === node && n.status === 'reported'),
      bot.name + ' reported evidence from its CLI', 150_000)
    assert.equal(result.ownerId, bot.id)
    assert.ok(result.evidence.includes(expected), result.evidence)
    if (node === 'sum') assert.equal((await run()).nodes.find(n => n.nodeId === 'product').status, 'waiting')
    const task = (await host.snapshot()).tasks.find(t => t.id === result.taskId)
    await dispatch('task.review', { taskId: task.id, approve: true, expectedRevision: task.revision,
      expectedEvidenceRevision: result.evidenceRevision, evidence: expected })
  }
  assert.equal((await run()).status, 'completed')
  const saved = JSON.parse(await readFile(join(host.home, 'godbot/web/team-workspace/state.json'), 'utf8'))
  const bindings = [first, second].map(bot => saved.localAgents.sessions[saved.bots[bot.id].sessionId ?? bot.id])
  assert.deepEqual(bindings.map(b => b.route), ['local-claude-code', 'local-codex-cli'])
  assert.ok(bindings.every(b => b.cliSessionId))
  assert.notEqual(bindings[0].cliSessionId, bindings[1].cliSessionId)
  await host.restart()
  const restored = await history()
  assert.equal(restored.items.length, 1)
  assert.equal(restored.items[0].runId, occurrence.runId)
  assert.equal(restored.items[0].state, 'completed')
  note('scheduled-bot-workflow', { marker, workflowId: flow.id, runId: occurrence.runId, bots: [first.id, second.id],
    versions: [claude.version, codex.version], nativeSessions: bindings.map(b => b.cliSessionId) })
}
