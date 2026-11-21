import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/host/store.js'
import { UsagePolicy } from '../fixtures/member-usage.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-policy-'))
  const store = new Store(dir)
  const clock = { time: Date.UTC(2026, 10, 20, 12) }
  const policy = new UsagePolicy({ store }, () => clock.time)
  t.after(async () => {
    policy.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { policy, clock, store }
}

test('member and profile caps share a UTC ledger with distinct zero, missing and unpriced receipts', async (t) => {
  const { policy, clock } = await fixture(t)
  const a = { id: 'a', kind: 'claude', nativeSettings: { model: 'chosen' } },
    b = { id: 'b', kind: 'codex' }
  policy.configure('a', { dailyTokens: 3 })
  policy.configure('profile', { monthlyUsd: 0.000011, rates: { 'claude/chosen': { input: 1, output: 5 } } })
  const call = { usageId: 'c', usage: { inputTokens: 1, outputTokens: 2 } }
  policy.native(a, { id: '1' }, call)
  policy.native(a, { id: '1' }, call)
  policy.finishNative(a, { id: '1' })
  policy.native(b, { id: '2' }, { usageId: 'c', usage: { inputTokens: 0, outputTokens: 0 } })
  policy.finishNative(b, { id: '3' })
  assert.equal(policy.snapshot('a').daily.calls, 1)
  const total = policy.snapshot('profile').monthly
  assert.equal(total.tokens, 3)
  assert.equal(total.unreported, 1)
  assert.equal(total.unpricedCalls, 1)
  assert.equal(total.estimatedUsd, 0.000011)
  assert.equal(policy.refusal('a', true).limit, 'monthlyUsd')
  assert.equal(policy.refusal('a', false), undefined)
  policy.configure('profile', {})
  assert.equal(policy.refusal('a', true).limit, 'dailyTokens')
  assert.equal(policy.refusal('b', true), undefined)
  clock.time += 86400000
  policy.native(a, { id: '1' }, call)
  assert.equal(policy.refusal('a', true), undefined)
  assert.equal(policy.snapshot('a').monthly.tokens, 3)
})
test('only a confirmed quota failure before streamed content can change the model request', async (t) => {
  const { policy, store } = await fixture(t)
  const primary = { provider: 'a', model: '1', sessionId: 's' },
    backup = { provider: 'b', model: '2' }
  let calls = 0
  const ctx = {
    llm: {
      stream: async function* () {
        calls++
        yield { type: 'text-delta', text: 'OK' }
      },
    },
  }
  const quota = { type: 'finish', reason: { kind: 'error', failure: { code: 'ACCOUNT_QUOTA' } } }
  async function invoke(chunks) {
    return Array.fromAsync(
      policy.modelStream(
        ctx,
        primary,
        async function* () {
          yield* chunks
        },
        'a',
        backup,
        new WeakSet(),
      ),
    )
  }
  await invoke([{ type: 'tool-call-delta', name: 'alreadyStarted' }, quota])
  await invoke([{ type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT' } } }])
  assert.equal(calls, 0)
  assert.deepEqual(await invoke([quota]), [{ type: 'text-delta', text: 'OK' }])
  assert.equal(calls, 1)
  assert.equal(store.all('usageQuotaHolds').length, 1)
})
