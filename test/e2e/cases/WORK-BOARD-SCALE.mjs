import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import { openFullTeam } from '../native-ui.mjs'
import { channel } from './WORK-BOARD.mjs'

const p95 = (times) => Math.round([...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1] * 10) / 10
export async function seedHistory(host, owners) {
  await host.stop()
  // Only the scenario's disposable profile is populated. Inserting ordinary legacy
  // records while the host is down also exercises resumable historical indexing.
  const db = new DatabaseSync(join(host.home, 'godbot', 'web', 'godbot.sqlite3'))
  try {
    db.exec('BEGIN')
    const insert = db.prepare("INSERT INTO records(collection,id,data) VALUES('tasks',?,?)")
    for (let n = 0; n < 10100; n++) {
      const id = 'scale-' + n,
        active = n >= 10000
      insert.run(
        id,
        JSON.stringify({
          id,
          teamId: 'godbot-workspace',
          ownerId: owners[n % owners.length],
          requesterId: 'user',
          title: active ? 'Active scale job ' + n : 'Earlier completed job ' + n,
          criteria: 'fixture criteria',
          createdAt: new Date(1700000000000 + n).toISOString(),
          status: active ? 'working' : 'completed',
          revision: 2,
          attempt: 1,
          evidenceRevision: active ? 0 : 1,
          evidence: active ? '' : 'complete',
          dependsOn: [],
        }),
      )
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  await host.start()
  await openFullTeam(host)
}
export default async function check({ makeHost, candidate, note }) {
  const host = await makeHost()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const team = await host.bot('state'),
    owners = [team.mainBotId]
  for (let i = 1; i < 5; i++)
    owners.push(
      (await host.bot('create-bot', { name: 'Scale worker ' + i, model: 'deepseek-official/deepseek-flash' })).id,
    )
  const samples = async (count) => {
    const times = []
    for (let i = 0; i < count; i++) {
      const start = performance.now()
      await channel(host, 'board-view')
      times.push(performance.now() - start)
    }
    return times
  }
  const baseline = await samples(30)
  await seedHistory(host, owners)
  const start = performance.now(),
    v = await channel(host, 'board-view'),
    coldMs = Math.round(performance.now() - start)
  assert.equal(v.columns.find((c) => c.phase === 'done').total, 10000)
  assert.equal(v.columns.find((c) => c.phase === 'doing').total, 100)
  const reads = await samples(30),
    paints = [],
    rtt = []
  for (let i = 0; i < 30; i++) {
    const round = performance.now()
    await host.page
      .getByRole('button', { name: /^(Work board|工作看板)$/ })
      .first()
      .click()
    await host.page.locator('.wb-card').first().waitFor()
    paints.push(performance.now() - round)
    const begin = performance.now()
    await channel(host, 'hello')
    rtt.push(performance.now() - begin)
    await host.page
      .locator('.wb-shell')
      .getByRole('button', { name: /Close work board|关闭工作看板/ })
      .click()
  }
  const changes = await Promise.all(
    owners.map((owner, i) =>
      channel(host, 'board-action', {
        op: 'create',
        title: 'Parallel ' + i,
        owner,
        requestId: 'scale-worker-' + i,
      }),
    ),
  )
  assert.equal(new Set(changes.map((c) => c.id)).size, 5)
  const result = {
    cpu: cpus()[0]?.model,
    history: 10000,
    active: 100,
    workers: 5,
    n: 30,
    baselineRpcP95: p95(baseline),
    coldMs,
    rpcP95: p95(reads),
    webP95: p95(paints),
    localRttP95: p95(rtt),
  }
  note('board-scale', result)
  assert.ok(result.rpcP95 <= 200, 'board RPC p95 = ' + result.rpcP95)
  assert.ok(result.webP95 <= 1000, 'Web first cards p95 = ' + result.webP95)
}
