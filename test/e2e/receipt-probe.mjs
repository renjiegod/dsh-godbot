import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from './host.mjs'

export function configureCrashProbe(host) {
  const gate = join(host.root, 'receipt-fault.json')
  host.env.NODE_OPTIONS = '--import=' + new URL('./receipt-crash.mjs', import.meta.url).href
  host.env.GODBOT_E2E_COMMIT_GATE = gate
  return async function check(phase, submit, note) {
    const id = randomUUID()
    const before = (await host.snapshot()).tasks.length
    await writeFile(gate, JSON.stringify({ phase, requestId: id }))
    // The caller sees a lost connection. Neither an empty response nor a timeout is
    // evidence of a commit, so compare the rows after restarting the same profile.
    await Promise.resolve()
      .then(() => submit(id))
      .catch(() => {})
    await until(
      async () => (await readFile(gate + '.observed', 'utf8').catch(() => '')) === phase,
      'crash at ' + phase + ' commit',
    )
    await host.stop('SIGKILL')
    await host.start()
    const persisted = (await host.snapshot()).tasks.length
    assert.equal(persisted - before, phase === 'after' ? 1 : 0)
    const recovered = await submit(id)
    const replay = await submit(id)
    assert.equal(typeof recovered.runId, 'string')
    assert.equal(replay.runId, recovered.runId)
    assert.equal((await host.snapshot()).tasks.length, before + 1)
    note('receipt-crash-and-recovery', {
      phase,
      requestId: id,
      runId: replay.runId,
      committedBeforeRetry: persisted - before,
    })
  }
}
