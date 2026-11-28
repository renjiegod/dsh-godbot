import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completedPrefix } from '../e2e/release-checkpoint.mjs'

function fixture() {
  const current = {
    checkpointVersion: 1, strict: true, suite: 'release', revision: 'commit', platform: 'test', osRelease: 'os',
    versions: { dsh: '1' }, browser: { version: '2' }, relay: { sha256: 'relay' }, retries: 1, waived: [],
    archive: { sha256: 'archive', buildId: 'build' }, previous: { sha256: 'previous' }, legacyBaseline: { sha256: 'legacy' },
    cases: ['one', 'two', 'three'].map(id => ({ id, status: 'not-run', evidence: [] })),
  }
  const prior = structuredClone(current)
  Object.assign(prior.cases[0], { status: 'passed', attempts: [{ status: 'passed', endedAt: 'then' }],
    evidence: [{ event: 'started', buildId: 'build', clientSha256: 'client' }] })
  return { current, prior }
}

test('a strict release continues only its completed prefix, with the first evidence intact', () => {
  const { prior, current } = fixture()
  for (const result of [undefined, 'interrupted']) {
    prior.result = result
    assert.deepEqual(completedPrefix(current, prior, 'client'), [prior.cases[0]])
  }
})

test('an interrupted in-flight case is executed again and prior successful cases survive', () => {
  const { current, prior } = fixture()
  prior.result = 'interrupted'
  Object.assign(prior.cases[1], { status: 'interrupted', attempts: [{ status: 'interrupted' }] })
  assert.deepEqual(completedPrefix(current, prior, 'client'), [prior.cases[0]])
  prior.cases[1].attempts.unshift({ status: 'failed' })
  assert.deepEqual(completedPrefix(current, prior, 'client'), [])
})

test('a changed input, a partial selection or a completed or failed run starts a new full suite', () => {
  for (const change of [
    p => { p.checkpointVersion = 0 }, p => { p.suite = 'all' }, p => { p.strict = false },
    p => { p.archive.sha256 = 'different' }, p => { p.archive.buildId = 'different' }, p => { p.revision = 'different' },
    p => { p.previous.sha256 = 'different' }, p => { p.legacyBaseline.sha256 = 'different' }, p => { p.relay.sha256 = 'different' },
    p => { p.versions.dsh = 'different' }, p => { p.browser.version = 'different' }, p => { p.osRelease = 'different' },
    p => { p.retries++ }, p => { p.waived.push({ id: 'two' }) }, p => { p.cases.pop() },
    p => { p.result = 'failed' }, p => { p.result = 'passed' }, p => { p.endedAt = 'then' },
    p => { p.environmentFailure = 'interrupted host' }, p => { p.cases[0].evidence[0].clientSha256 = 'other' },
    p => { p.cases[0].attempts = [] }, p => { p.cases[0].attempts.unshift({ status: 'failed' }) },
    p => { p.cases[1].status = 'failed' }, p => { p.cases[2] = { ...p.cases[0], id: 'three' } },
  ]) {
    const { current, prior } = fixture()
    change(prior)
    assert.deepEqual(completedPrefix(current, prior, 'client'), [], String(change))
  }
})
