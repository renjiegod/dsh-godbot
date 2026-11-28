import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CANDIDATE_SCHEMA, ReleaseError, VERIFICATION_SCHEMA, candidateProblems, describe, promote, readback, readbackNet, verification,
} from '../../scripts/release-candidate.mjs'
import { release as releaseSuite } from '../e2e/suites.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')
const COMMIT = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const BUILD = '0123456789abcdef'

function archive(version, { buildId = BUILD } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-candidate-test-'))
  mkdirSync(join(dir, 'package/src/host'), { recursive: true })
  writeFileSync(join(dir, 'package/package.json'), JSON.stringify({ name: 'dsh-godbot', version }))
  writeFileSync(join(dir, 'package/src/host/build-id.js'), `export const buildId = "${buildId}"\n`)
  writeFileSync(join(dir, 'package/client.js'), 'window.__ModuleLoader__.load({ id: "dsh-godbot", factory(require) {\nconst module = { exports: {} }' +
    '\nreturn Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: "Module" });\n} });\n')
  const file = join(dir, `dsh-godbot-${version}.tgz`)
  execFileSync('tar', ['-czf', file, '-C', dir, 'package'])
  return { file, bytes: readFileSync(file) }
}

function strictReport(candidate, overrides = {}) {
  return {
    startedAt: '2026-11-27T01:00:00.000Z', endedAt: '2026-11-27T02:00:00.000Z', platform: 'darwin-arm64',
    versions: { dsh: 'dsh 0.2.2-rc.5', node: 'v24.14.0', pnpm: '11.1.2' }, strict: true, retries: 1, waived: [],
    archive: { sha256: candidate.archive.sha256, buildId: candidate.buildId, version: candidate.version },
    previous: { sha256: 'c'.repeat(64), buildId: 'fedcba9876543210', version: '0.9.0' },
    browser: { engine: 'chromium', version: '140.0', source: 'Playwright Chromium' }, relay: { version: '0.2.3' },
    cases: releaseSuite.map(id => ({ id, status: 'passed', attempts: [{ attempt: 1, status: 'passed' }], evidence: [] })),
    result: 'passed',
    ...overrides,
  }
}

async function fixture(version = '0.9.1') {
  const built = archive(version)
  const candidate = await describe(built.file, { commit: COMMIT, runUrl: 'https://github.com/renjiegod/dsh-godbot/actions/runs/1' })
  return { ...built, candidate, verified: verification(strictReport(candidate), candidate) }
}

test('an interrupted checkpoint or a report from another revision cannot authorize release', async () => {
  const { candidate } = await fixture()
  const report = strictReport(candidate, { checkpointVersion: 1, suite: 'release', revision: COMMIT })
  assert.equal(verification(report, candidate).result, 'passed')
  for (const override of [{ result: 'interrupted' }, { endedAt: undefined }, { revision: OTHER }, { suite: 'all' }]) {
    assert.throws(() => verification({ ...report, ...override }, candidate), /did not finish/)
  }
})

test('describe names the archive, its commit, hash and Host build', async () => {
  const { file, bytes } = archive('0.9.1')
  const candidate = await describe(file, { commit: COMMIT })
  assert.equal(candidate.schema, CANDIDATE_SCHEMA)
  assert.equal(candidate.tag, 'v0.9.1')
  assert.deepEqual(candidate.archive, { name: 'dsh-godbot-0.9.1.tgz', sha256: sha256(bytes), size: bytes.length })
  assert.equal(candidate.buildId, BUILD)
  await assert.rejects(describe(file, { commit: 'abc' }), ReleaseError)
})

test('a strict release report becomes verification.json; anything less does not', async () => {
  const { candidate, verified } = await fixture()
  assert.equal(verified.schema, VERIFICATION_SCHEMA)
  assert.equal(verified.archive.sha256, candidate.archive.sha256)
  assert.deepEqual(verified.cases.map(row => row.id), releaseSuite)
  assert.equal(JSON.stringify(verified).includes('Playwright'), false, 'local details stay out of the public record')

  const without = id => strictReport(candidate, { cases: strictReport(candidate).cases.filter(row => row.id !== id) })
  assert.throws(() => verification(without('PHONE'), candidate), /no result for PHONE/)
  assert.throws(() => verification(strictReport(candidate, { strict: false }), candidate), /not a passed strict run/)
  assert.throws(() => verification(strictReport(candidate, { archive: { sha256: 'd'.repeat(64) } }), candidate), /tested the archive/)

  const skipped = strictReport(candidate)
  skipped.cases.find(row => row.id === 'REMOTE-COMPUTERS').status = 'skipped'
  assert.throws(() => verification(skipped, candidate), /REMOTE-COMPUTERS is skipped/)
  const waived = { ...skipped, waived: [{ id: 'REMOTE-COMPUTERS', reason: 'Relay host offline for maintenance' }] }
  assert.equal(verification(waived, candidate).waived[0].id, 'REMOTE-COMPUTERS')
})

test('a rerun on the same archive keeps the first failure in the attempts', async () => {
  const { candidate } = await fixture()
  const first = strictReport(candidate)
  const update = first.cases.find(row => row.id === 'UPDATE')
  update.status = 'failed'
  update.attempts = [{ attempt: 1, status: 'failed' }]
  assert.throws(() => verification(first, candidate), /UPDATE is failed/)
  const rerun = strictReport(candidate, { cases: [{ id: 'UPDATE', status: 'passed', attempts: [{ attempt: 1, status: 'passed' }] }] })
  const record = verification(first, candidate, [rerun])
  assert.deepEqual(record.cases.find(row => row.id === 'UPDATE'), { id: 'UPDATE', status: 'passed', attempts: ['failed', 'passed'], flaky: true })
  assert.throws(() => verification(first, candidate, [{ ...rerun, archive: { sha256: 'e'.repeat(64) } }]), /another archive/)
})

const asset = (id, name, bytes) => ({ id, name, size: bytes.length, digest: 'sha256:' + sha256(bytes), browser_download_url: `https://example.test/${name}` })

function releaseFor({ candidate, verified, bytes }, { draft = true, id = 7, tag = candidate.tag } = {}) {
  const files = {
    'candidate.json': Buffer.from(JSON.stringify(candidate)),
    'verification.json': Buffer.from(JSON.stringify(verified)),
    [candidate.archive.name]: bytes,
    [candidate.archive.name + '.sha256']: Buffer.from(`${sha256(bytes)}  ${candidate.archive.name}\n`),
  }
  const assets = Object.entries(files).map(([name, data], index) => asset(100 + index, name, data))
  return { release: { id, tag_name: tag, draft, prerelease: false, target_commitish: COMMIT, assets, html_url: 'https://example.test/release' }, files }
}

function fakeGh(releases, files) {
  const calls = []
  const byId = new Map(releases.flatMap(item => item.assets.map(entry => [String(entry.id), entry.name])))
  const gh = (args, { binary = false } = {}) => {
    calls.push(args)
    const path = args.at(-1)
    if (args[1] === '-X') return '{}'
    if (/releases\?per_page=100$/.test(path)) return JSON.stringify(releases)
    const id = /releases\/assets\/(\d+)$/.exec(path)?.[1]
    if (id && binary) return files[byId.get(id)]
    throw new Error('unexpected gh ' + args.join(' '))
  }
  return { gh, calls }
}

function fakeGit({ tagged = COMMIT, onMain = true } = {}) {
  return (args) => {
    if (args[0] === 'rev-parse') { if (!tagged) throw new Error('no tag'); return tagged }
    if (args[0] === 'fetch') return ''
    if (args[0] === 'merge-base') { if (!onMain) throw new Error('not ancestor'); return '' }
    throw new Error('unexpected git ' + args.join(' '))
  }
}

function packageDir(version) {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-promote-test-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-godbot', version }))
  return dir
}

test('candidateProblems catches a tampered archive, a wrong digest and a stale sidecar', async () => {
  const made = await fixture()
  const { release, files } = releaseFor(made)
  const archiveAsset = release.assets.find(entry => entry.name === made.candidate.archive.name)
  const base = { tag: 'v0.9.1', version: '0.9.1', release, candidate: made.candidate, verified: made.verified, archiveAsset, archiveBytes: made.bytes,
    sidecar: files[archiveAsset.name + '.sha256'].toString(), archive: { version: '0.9.1', buildId: BUILD } }
  assert.deepEqual(candidateProblems(base), [])
  const tampered = Buffer.concat([made.bytes, Buffer.from('x')])
  assert.ok(candidateProblems({ ...base, archiveBytes: tampered }).some(line => line.includes("archive's SHA-256")))
  assert.ok(candidateProblems({ ...base, archiveAsset: { ...archiveAsset, digest: 'sha256:' + 'f'.repeat(64) } }).some(line => line.startsWith('GitHub records')))
  assert.ok(candidateProblems({ ...base, sidecar: 'f'.repeat(64) }).some(line => line.includes('.sha256 does not state')))
  assert.ok(candidateProblems({ ...base, release: { ...release, target_commitish: OTHER } }).some(line => line.includes('The draft targets')))
})

test('promote publishes the verified draft and nothing else', async () => {
  const made = await fixture()
  const { release, files } = releaseFor(made)
  const { gh, calls } = fakeGh([release], files)
  const log = () => {}
  const result = await promote({ repo: 'renjiegod/dsh-godbot', tag: 'v0.9.1', cwd: packageDir('0.9.1'), gh, git: fakeGit(), log })
  assert.equal(result.changed, true)
  assert.deepEqual(calls.at(-1), ['api', '-X', 'PATCH', 'repos/renjiegod/dsh-godbot/releases/7', '-F', 'draft=false', '-f', 'make_latest=true'])
  assert.equal(calls.filter(args => args.includes('upload') || args.includes('--clobber')).length, 0)

  const dry = fakeGh([release], files)
  assert.equal((await promote({ repo: 'r/r', tag: 'v0.9.1', cwd: packageDir('0.9.1'), gh: dry.gh, git: fakeGit(), dryRun: true, log })).changed, false)
  assert.equal(dry.calls.some(args => args[1] === '-X'), false)

  const published = releaseFor(made, { draft: false })
  const again = fakeGh([published.release], published.files)
  assert.deepEqual((await promote({ repo: 'r/r', tag: 'v0.9.1', cwd: packageDir('0.9.1'), gh: again.gh, git: fakeGit(), log })).changed, false)
  assert.equal(again.calls.some(args => args[1] === '-X'), false)
})

test('promote refuses a wrong tag, an unverified archive, a commit off main and an older version', async () => {
  const made = await fixture()
  const { release, files } = releaseFor(made)
  const run = (options = {}) => {
    const { gh } = fakeGh(options.releases ?? [release], options.files ?? files)
    return promote({ repo: 'r/r', tag: 'v0.9.1', cwd: packageDir('0.9.1'), gh, git: fakeGit(options.git), log: () => {}, beforeTag: options.beforeTag })
  }
  await assert.rejects(run({ git: { tagged: OTHER } }), /points at b{40}/)
  await assert.rejects(run({ git: { tagged: '' } }), /points at nothing/)
  assert.equal((await run({ git: { tagged: '' }, beforeTag: true })).changed, true)
  await assert.rejects(run({ git: { onMain: false } }), /is not on main/)
  const newerRelease = { ...releaseFor(made, { draft: false, id: 8, tag: 'v0.9.2' }).release }
  await assert.rejects(run({ releases: [release, newerRelease] }), /v0\.9\.2 is already published/)
  const unverified = { ...files, 'verification.json': Buffer.from(JSON.stringify({ ...made.verified, strict: false })) }
  await assert.rejects(run({ files: unverified }), /not a passed strict run/)
  await assert.rejects(run({ releases: [] }), /no release candidate for v0\.9\.1/)
  await assert.rejects(promote({ repo: 'r/r', tag: 'v0.9.1', cwd: packageDir('0.9.0'), gh: fakeGh([release], files).gh, git: fakeGit(), log: () => {} }), /does not match package.json/)
})

function fakeNet(releases, files, { status = null } = {}) {
  return {
    async json(url) {
      if (status) throw new Error(`${url} answered ${status}`)
      if (url.endsWith('/releases?per_page=30')) return releases
      const tag = /releases\/tags\/(.+)$/.exec(url)?.[1]
      if (tag) return releases.find(item => item.tag_name === tag)
      throw new Error('unexpected url ' + url)
    },
    async text(url) { return files[url.split('/').at(-1)].toString() },
    async download(url, path) { writeFileSync(path, files[url.split('/').at(-1)]) },
  }
}

test('readback sees the release the way an installed Godbot does', async () => {
  const made = await fixture()
  const { release, files } = releaseFor(made, { draft: false })
  const result = await readback({ repo: 'r/r', tag: 'v0.9.1', net: fakeNet([release], files), log: () => {} })
  assert.equal(result.sha256, made.candidate.archive.sha256)
  assert.equal(result.buildId, BUILD)

  const newerOne = releaseFor(made, { draft: false, id: 9, tag: 'v0.9.2' }).release
  newerOne.assets = newerOne.assets.map(entry => ({ ...entry, name: entry.name.replace('0.9.1', '0.9.2') }))
  await assert.rejects(readback({ repo: 'r/r', tag: 'v0.9.1', net: fakeNet([release, newerOne], files), log: () => {} }), /would update to v0\.9\.2/)
  const draftOnly = releaseFor(made, { draft: true }).release
  await assert.rejects(readback({ repo: 'r/r', tag: 'v0.9.1', net: fakeNet([draftOnly], files), log: () => {} }), /No published dsh-godbot release/)
  const other = { ...made.candidate, archive: { ...made.candidate.archive, sha256: '0'.repeat(64) } }
  await assert.rejects(readback({ repo: 'r/r', tag: 'v0.9.1', candidate: other, net: fakeNet([release], files), log: () => {} }), /not the verified/)
})

test('a readback uses a token only for the API, and only once anonymous calls are rate-limited', async () => {
  const seen = []
  const fetch = async (url, init) => {
    seen.push([url, Boolean(init.headers.authorization)])
    if (!init.headers.authorization) return new Response('limited', { status: 403 })
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const net = readbackNet({ token: 't', fetch })
  assert.deepEqual(await net.json('https://api.github.com/repos/r/r/releases?per_page=30'), [])
  assert.equal(net.state.authenticated, true)
  assert.deepEqual(seen.map(([, auth]) => auth), [false, true])
  await assert.rejects(net.json('https://example.test/other.json'), /answered 403/)
})
