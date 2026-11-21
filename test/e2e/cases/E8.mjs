import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { until } from '../host.mjs'

const run = promisify(execFile)
export default async function E8({ makeHost, candidate, scratch, note }) {
  const a = await makeHost(), b = await makeHost()
  await Promise.all([a.install(candidate), b.install(candidate)])
  await Promise.all([a.start(), b.start()])
  const initial = await b.snapshot()
  const worker = await a.bot('create-bot', { name: 'Archive Worker', model: 'deepseek-official/deepseek-flash' })
  const evidence = 'archive-' + randomUUID()
  a.model.reply = () => evidence
  const { id } = await a.rpc('dispatch', { request: { action: 'task.create', ownerId: worker.id, title: 'Keep this assignment', criteria: 'Return the receipt', requestId: randomUUID() } })
  await until(async () => (await a.snapshot()).tasks.find(t => t.id === id && t.status === 'reported' && t.evidence === evidence), 'live Bot assignment evidence')
  const src = await a.bot('chat', { botId: worker.id })
  await Promise.all([a.stop(), b.stop()])
  const pass = join(scratch, 'password'), archive = join(scratch, 'team.godbot')
  await writeFile(pass, randomUUID(), { mode: 0o600 })
  const cli = (host, command, extra = []) => run(process.execPath, [join(host.home, 'profiles/web/node_modules/dsh-godbot/bin/godbot.mjs'),
    'workspace', command, '--home', host.home, '--file', archive, '--password-file', pass, ...extra], { timeout: 30000 })
  await cli(a, 'backup')
  await cli(b, 'restore', ['--map', a.workspace + '=' + b.workspace])
  await b.start()
  const restored = await b.snapshot()
  const task = restored.tasks.find(t => t.id === id)
  assert.equal(task.ownerId, worker.id)
  assert.equal(task.evidence, evidence)
  assert.equal((await b.bot('chat', { botId: worker.id })).sessionId, src.sessionId)
  assert.ok(restored.bots.some(bot => bot.id === worker.id))
  await b.stop()
  await cli(b, 'rollback')
  await b.start()
  const reverted = await b.snapshot()
  assert.deepEqual(reverted.bots.map(bot => bot.id), initial.bots.map(bot => bot.id))
  assert.ok(!reverted.tasks.some(t => t.id === id))
  note('single-roster-archive', { botId: worker.id, sessionId: src.sessionId, restoredTaskId: id, rollback: true })
}
