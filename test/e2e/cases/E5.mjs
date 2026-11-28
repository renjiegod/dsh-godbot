import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { configureCrashProbe } from '../receipt-probe.mjs'
import { ciTeam } from '../automation-client.mjs'
import { until } from '../host.mjs'

export default async function E5({ makeHost, candidate, note }) {
  const host = await makeHost()
  const probe = configureCrashProbe(host)
  const ci = await ciTeam(host, candidate)
  for (const phase of ['before', 'after']) {
    const worker = await ci.extra('Commit-' + phase)
    await probe(
      phase,
      async (id) =>
        (
          await ci.cli(
            'run',
            '--title',
            'Check commit',
            '--criteria',
            'Commit receipt',
          '--bot',
            worker.id,
            '--request-id',
            id,
          )
        ).data,
      note,
    )
  }
  const id = randomUUID(),
    marker = 'E5-' + id
  const seen = new Set()
  const gate = Promise.withResolvers()
  host.model.reply = async (body, call) => {
    if (JSON.stringify(body.messages.at(-1)).includes(marker)) {
      seen.add(call.id)
      await gate.promise
    }
    return 'Finished'
  }
  const args = ['run', '--title', marker, '--criteria', 'Record a receipt', '--request-id', id]
  const [a, b] = await Promise.all([ci.cli(...args), ci.cli(...args)])
  assert.equal(a.code, 0)
  assert.deepEqual(b, a)
  const { runId } = a.data
  assert.equal((await ci.cli(...args.map((arg) => (arg === marker ? 'Different task' : arg)))).code, 2)
  try {
    await until(() => seen.size === 1, 'the Bot session entered its assigned task')
    await host.stop('SIGKILL')
  } finally {
    gate.resolve()
  }
  await host.start()
  assert.deepEqual(await ci.cli(...args), a)
  const recovered = await ci.lookup(runId, row => row.tasks?.some(task => task.status === 'reported'))
  assert.equal((await ci.cli('wait', runId)).code, 3)
  assert.equal(recovered.tasks.length, 1)
  assert.equal(recovered.tasks[0].attempt, 1)
  assert.equal(seen.size, 2)
  const snapshot = await host.snapshot()
  assert.equal(snapshot.tasks.filter((t) => t.runId === runId).length, 1)
  note('resumed-after-crash', { runId, fixtureSubmissions: seen.size, tasks: 1 })
}
