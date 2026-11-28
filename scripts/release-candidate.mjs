// Release candidates. A Godbot release is built once, by candidate.yml, from an
// exact commit on main and staged on a draft GitHub release together with
// candidate.json (commit, version, archive SHA-256, Host build ID). Installed
// Godbots never see drafts. The strict release e2e suite then verifies that
// archive, and its report becomes verification.json on the same draft. Pushing
// the version tag runs release.yml, which publishes the draft only when the tag,
// the archive bytes and both records agree: nothing is rebuilt or re-uploaded,
// so the published archive is the one that was tested, and a published release
// is never changed afterwards.
//
//   node scripts/release-candidate.mjs describe <tgz> --commit <sha> [--run-url <url>]
//   node scripts/release-candidate.mjs verification <report.json> --candidate <candidate.json> [--rerun <report.json> ...]
//   node scripts/release-candidate.mjs promote --repo <owner/name> --tag <vX.Y.Z> [--dry-run] [--before-tag]
//   node scripts/release-candidate.mjs readback --repo <owner/name> --tag <vX.Y.Z> [--candidate <candidate.json>]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { assetName, createNet, downloadArchive, GITHUB_API, newer, newestRelease, sidecarDigest } from '../src/host/team-runtime/core/update-release.js'
import { inspectArchive } from '../test/e2e/artifacts.mjs'
import { release as releaseSuite } from '../test/e2e/suites.mjs'

export const CANDIDATE_SCHEMA = 'godbot.candidate.v1'
export const VERIFICATION_SCHEMA = 'godbot.verification.v1'
const NAME = 'dsh-godbot'
const COMMIT = /^[0-9a-f]{40}$/
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/

const sha256 = data => createHash('sha256').update(data).digest('hex')

export class ReleaseError extends Error {}
const fail = message => { throw new ReleaseError(message) }

export function tagVersion(tag) {
  return TAG.exec(String(tag ?? ''))?.[1] ?? fail(`${tag} is not a version tag like v1.2.3`)
}

/** candidate.json for an archive candidate.yml packed from `commit`. */
export async function describe(file, { commit, runUrl = null }) {
  if (!COMMIT.test(String(commit ?? ''))) fail('describe needs --commit with a full 40-character commit SHA')
  const archive = await inspectArchive(file)
  const name = assetName(NAME, archive.version)
  if (basename(file) !== name) fail(`The archive is named ${basename(file)}, not ${name}`)
  return {
    schema: CANDIDATE_SCHEMA,
    package: NAME,
    version: archive.version,
    tag: 'v' + archive.version,
    commit,
    archive: { name, sha256: archive.sha256, size: statSync(file).size },
    buildId: archive.buildId,
    clientSha256: archive.clientSha256,
    built: { runUrl, platform: process.platform + '-' + process.arch, node: process.version },
    createdAt: new Date().toISOString(),
  }
}

/** Problems with a verification.json record for `candidate`; empty when it vouches for it. */
export function verificationProblems(verified, candidate) {
  if (verified?.schema !== VERIFICATION_SCHEMA) return [`verification.json is not a ${VERIFICATION_SCHEMA} record`]
  const problems = []
  if (verified.archive?.sha256 !== candidate?.archive?.sha256) problems.push(`verification.json verified the archive ${verified.archive?.sha256}, not ${candidate?.archive?.sha256}`)
  if (verified.commit !== candidate?.commit) problems.push(`verification.json names the commit ${verified.commit}, not ${candidate?.commit}`)
  if (verified.suite !== 'release' || verified.strict !== true || verified.result !== 'passed') problems.push('verification.json is not a passed strict run of the release suite')
  const rows = new Map((Array.isArray(verified.cases) ? verified.cases : []).map(row => [row?.id, row]))
  const waived = new Set((Array.isArray(verified.waived) ? verified.waived : []).filter(item => String(item?.reason ?? '').trim()).map(item => item.id))
  for (const id of releaseSuite) {
    const row = rows.get(id)
    if (!row) problems.push(`verification.json has no result for ${id}`)
    else if (row.status !== 'passed' && !(row.status === 'skipped' && waived.has(id))) problems.push(`${id} is ${row.status} in verification.json`)
  }
  return problems
}

/**
 * verification.json from a strict release-suite report (scripts/e2e.mjs) of the
 * candidate's archive. A case run again later on the same archive (--rerun)
 * keeps its first result in the attempts.
 */
export function verification(report, candidate, reruns = []) {
  const problems = []
  if (report?.archive?.sha256 !== candidate.archive.sha256) problems.push(`The report tested the archive ${report?.archive?.sha256}, not ${candidate.archive.sha256}`)
  if (report?.checkpointVersion && (report.suite !== 'release' || report.revision !== candidate.commit || !report.endedAt || !['passed', 'failed'].includes(report.result))) {
    problems.push('The release suite for this candidate commit did not finish')
  }
  if (report?.environmentFailure) problems.push('The run stopped with an environment failure')
  const attemptsOf = row => (Array.isArray(row.attempts) && row.attempts.length ? row.attempts : [{ status: row.status }]).map(item => item.status)
  const rows = new Map((report?.cases ?? []).map(row => [row.id, { id: row.id, status: row.status, attempts: attemptsOf(row) }]))
  for (const rerun of reruns) {
    if (rerun?.archive?.sha256 !== candidate.archive.sha256) { problems.push('A rerun report tested another archive'); continue }
    if (rerun.strict !== true) problems.push('A rerun report was not made with --strict')
    if (rerun.environmentFailure) problems.push('A rerun stopped with an environment failure')
    for (const row of rerun.cases ?? []) {
      const target = rows.get(row.id)
      if (!target) { problems.push(`${row.id} was rerun but is not in the release report`); continue }
      target.attempts.push(...attemptsOf(row))
      target.status = row.status
    }
  }
  for (const row of rows.values()) if (row.status === 'passed' && row.attempts[0] !== 'passed') row.flaky = true
  const last = [report, ...reruns].map(item => item?.endedAt).filter(Boolean).sort().at(-1) ?? null
  const record = {
    schema: VERIFICATION_SCHEMA,
    package: NAME,
    version: candidate.version,
    commit: candidate.commit,
    archive: { name: candidate.archive.name, sha256: candidate.archive.sha256, buildId: candidate.buildId },
    suite: 'release',
    strict: report?.strict === true && reruns.every(item => item?.strict === true),
    result: 'passed',
    platform: report?.platform ?? null,
    versions: report?.versions ?? null,
    browser: report?.browser ? { engine: report.browser.engine, version: report.browser.version } : null,
    relay: report?.relay ?? null,
    previous: report?.previous ? { version: report.previous.version, sha256: report.previous.sha256, buildId: report.previous.buildId } : null,
    cases: [...rows.values()],
    waived: (report?.waived ?? []).map(item => ({ id: item.id, reason: item.reason })),
    startedAt: report?.startedAt ?? null,
    endedAt: last,
  }
  problems.push(...verificationProblems(record, candidate))
  if (problems.length) fail(`This report does not verify ${candidate.tag}:\n- ${problems.join('\n- ')}`)
  return record
}

/** Problems with a release's records and archive for publishing `tag`; empty when they agree. */
export function candidateProblems({ tag, version, release, candidate, verified, archiveAsset, archiveBytes, sidecar, archive }) {
  const problems = []
  const expect = (ok, message) => { if (!ok) problems.push(message) }
  expect(candidate?.schema === CANDIDATE_SCHEMA, `candidate.json is not a ${CANDIDATE_SCHEMA} record`)
  expect(candidate?.tag === tag && candidate?.version === version, `candidate.json describes ${candidate?.tag}, not ${tag}`)
  expect(COMMIT.test(String(candidate?.commit ?? '')), 'candidate.json names no commit')
  if (release.draft) expect(release.target_commitish === candidate?.commit, `The draft targets ${release.target_commitish}, not the candidate's commit ${candidate?.commit}`)
  const actual = sha256(archiveBytes)
  expect(actual === candidate?.archive?.sha256, `The release archive's SHA-256 is ${actual}, not the candidate's ${candidate?.archive?.sha256}`)
  expect(archiveAsset.digest === 'sha256:' + actual, `GitHub records ${archiveAsset.digest ?? 'no digest'} for ${archiveAsset.name}, not sha256:${actual}`)
  expect(archiveAsset.size === candidate?.archive?.size, `${archiveAsset.name} has ${archiveAsset.size} bytes, not the candidate's ${candidate?.archive?.size}`)
  expect(sidecarDigest(sidecar) === actual, `${archiveAsset.name}.sha256 does not state the archive's SHA-256`)
  expect(archive.version === version, `The archive holds version ${archive.version}, not ${version}`)
  expect(archive.buildId === candidate?.buildId, `The archive's Host build ID ${archive.buildId} is not the candidate's ${candidate?.buildId}`)
  problems.push(...verificationProblems(verified, candidate))
  return problems
}

const runGh = (args, { binary = false } = {}) =>
  execFileSync('gh', args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const runGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * Publish the draft release for `tag` once everything about it agrees, or
 * re-check a release that is already published. With `beforeTag` the tag does
 * not have to exist yet (the release tool checks before pushing it); otherwise
 * it must point at the candidate's commit. Nothing is uploaded here.
 */
export async function promote({ repo, tag, dryRun = false, beforeTag = false, cwd = process.cwd(), gh = runGh, git = runGit, log = message => console.error(message) }) {
  const version = tagVersion(tag)
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  if (pkg.version !== version) fail(`${tag} does not match package.json version ${pkg.version}`)
  const releases = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`]))
  if (!Array.isArray(releases)) fail('GitHub answered without a list of releases')
  const matching = releases.filter(item => item?.tag_name === tag)
  if (matching.length === 0) fail(`There is no release candidate for ${tag}: run candidate.yml on its commit first`)
  if (matching.length > 1) fail(`${matching.length} releases name ${tag}; delete the stale drafts first`)
  const [release] = matching
  const assetOf = name => (release.assets ?? []).find(item => item?.name === name) ?? fail(`The ${tag} release has no ${name}`)
  const download = asset => gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], { binary: true })
  const dir = mkdtempSync(join(tmpdir(), 'godbot-promote-'))
  try {
    const parse = (asset) => {
      try { return JSON.parse(Buffer.from(download(asset)).toString('utf8')) } catch (error) { return fail(`${asset.name} is not readable JSON: ${error.message}`) }
    }
    const candidate = parse(assetOf('candidate.json'))
    const verified = parse(assetOf('verification.json'))
    const archiveAsset = assetOf(assetName(NAME, version))
    const archiveBytes = Buffer.from(download(archiveAsset))
    const sidecar = Buffer.from(download(assetOf(archiveAsset.name + '.sha256'))).toString('utf8')
    const archivePath = join(dir, archiveAsset.name)
    writeFileSync(archivePath, archiveBytes)
    const problems = candidateProblems({ tag, version, release, candidate, verified, archiveAsset, archiveBytes, sidecar, archive: await inspectArchive(archivePath) })
    let tagged = ''
    try { tagged = git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag + '^{commit}'], cwd) } catch { /* no such tag */ }
    if (tagged ? tagged !== candidate.commit : !beforeTag) problems.push(`${tag} points at ${tagged || 'nothing'}, not the candidate's commit ${candidate.commit}`)
    git(['fetch', '--quiet', 'origin', 'main'], cwd)
    try { git(['merge-base', '--is-ancestor', candidate.commit, 'origin/main'], cwd) } catch { problems.push(`The candidate's commit ${candidate.commit} is not on main`) }
    for (const other of releases) {
      if (other === release || other?.draft) continue
      const otherVersion = TAG.exec(String(other?.tag_name ?? ''))?.[1]
      if (otherVersion && newer(otherVersion, version)) problems.push(`${other.tag_name} is already published; ${tag} would come out after a newer release`)
    }
    if (problems.length) fail(`${tag} cannot be published:\n- ${problems.join('\n- ')}`)
    if (!release.draft) {
      log(`${tag} is already published with the verified archive ${candidate.archive.sha256}`)
      return { tag, published: true, changed: false, candidate }
    }
    if (dryRun) {
      log(`${tag} is ready to publish (dry run): ${candidate.archive.name} ${candidate.archive.sha256}`)
      return { tag, published: false, changed: false, candidate }
    }
    gh(['api', '-X', 'PATCH', `repos/${repo}/releases/${release.id}`, '-F', 'draft=false', '-f', `make_latest=${version.includes('-') ? 'false' : 'true'}`])
    log(`Published ${tag}: ${candidate.archive.name} ${candidate.archive.sha256}`)
    return { tag, published: true, changed: true, candidate }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Network access for a readback: anonymous, as installed Godbots read releases.
 * Shared CI addresses can run out of anonymous API calls; then, and only for the
 * API, `token` is used and the result says so.
 */
export function readbackNet({ token = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  const userAgent = 'dsh-godbot-release-readback'
  const anonymous = createNet({ userAgent, timeoutMs: 20_000, fetch: fetchImpl })
  const state = { authenticated: false }
  if (!token) return { ...anonymous, state }
  const withToken = createNet({ userAgent, timeoutMs: 20_000, fetch: (url, init) => fetchImpl(url, { ...init, headers: { ...init.headers, authorization: 'Bearer ' + token } }) })
  const limited = error => /answered (403|429)$/.test(String(error?.message))
  return {
    ...anonymous,
    state,
    async json(url) {
      try { return await anonymous.json(url) } catch (error) {
        if (!limited(error) || !String(url).startsWith(GITHUB_API + '/')) throw error
        state.authenticated = true
        return withToken.json(url)
      }
    },
  }
}

/**
 * Read a published release back the way an installed Godbot finds and checks it
 * (update-release.js): the newest release must be `tag`, and its archive must
 * download with the candidate's SHA-256, version and Host build ID.
 */
export async function readback({ repo, tag, candidate = null, net = readbackNet({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null }), log = message => console.error(message) }) {
  const version = tagVersion(tag)
  const found = await newestRelease({ repo, name: NAME, prerelease: version.includes('-'), net })
  if (!found) fail(`No published ${NAME} release is visible to installed Godbots`)
  if (found.tag !== tag) fail(`Installed Godbots would update to ${found.tag}, not ${tag}`)
  if (!candidate) {
    const published = await net.json(`${GITHUB_API}/repos/${repo}/releases/tags/${tag}`)
    const record = (published?.assets ?? []).find(item => item?.name === 'candidate.json')
    if (typeof record?.browser_download_url !== 'string') fail(`${tag} has no candidate.json`)
    candidate = JSON.parse(await net.text(record.browser_download_url))
  }
  if (found.asset.sha256 !== candidate.archive?.sha256) fail(`${tag} offers the archive ${found.asset.sha256}, not the verified ${candidate.archive?.sha256}`)
  const dir = mkdtempSync(join(tmpdir(), 'godbot-readback-'))
  try {
    const path = await downloadArchive({ dir, name: NAME, version, asset: found.asset, net })
    const archive = await inspectArchive(path)
    if (archive.version !== version) fail(`The downloaded archive holds ${archive.version}, not ${version}`)
    if (archive.buildId !== candidate.buildId) fail(`The downloaded archive's Host build ID ${archive.buildId} is not the candidate's ${candidate.buildId}`)
    const result = { tag, version, sha256: archive.sha256, size: found.asset.size, buildId: archive.buildId, url: found.asset.url, notesUrl: found.notesUrl, authenticated: net.state?.authenticated === true }
    log(`Read back ${tag} as installed Godbots see it: ${found.asset.name} ${archive.sha256}, build ${archive.buildId}${result.authenticated ? ' (release list read with a token: anonymous API calls were rate-limited)' : ''}`)
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const readJson = file => JSON.parse(readFileSync(resolve(file), 'utf8'))

export async function main(argv) {
  const [command, ...rest] = argv
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    commit: { type: 'string' }, 'run-url': { type: 'string' }, candidate: { type: 'string' }, rerun: { type: 'string', multiple: true },
    repo: { type: 'string' }, tag: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'before-tag': { type: 'boolean' },
  } })
  const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  const need = (value, flag) => value ?? fail(`${command} needs ${flag}`)
  switch (command) {
    case 'describe':
      return print(await describe(need(positionals[0], '<tgz>'), { commit: values.commit, runUrl: values['run-url'] ?? null }))
    case 'verification':
      return print(verification(readJson(need(positionals[0], '<report.json>')), readJson(need(values.candidate, '--candidate')), (values.rerun ?? []).map(readJson)))
    case 'promote': {
      const { candidate, ...result } = await promote({ repo: need(values.repo, '--repo'), tag: need(values.tag, '--tag'), dryRun: values['dry-run'] === true, beforeTag: values['before-tag'] === true })
      return print({ ...result, sha256: candidate.archive.sha256, buildId: candidate.buildId, commit: candidate.commit })
    }
    case 'readback':
      return print(await readback({ repo: need(values.repo, '--repo'), tag: need(values.tag, '--tag'), candidate: values.candidate ? readJson(values.candidate) : null }))
    default:
      fail('Use: describe | verification | promote | readback (see the top of scripts/release-candidate.mjs)')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof ReleaseError ? error.message : error.stack ?? error)
    process.exitCode = 1
  })
}
