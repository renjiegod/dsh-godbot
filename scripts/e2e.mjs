import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildArchive, inspectArchive, repository, saveEvidence } from '../test/e2e/artifacts.mjs'
import { createHost, EnvironmentError, installedVersions, openBrowser, redact } from '../test/e2e/host.mjs'
import { all, androidCases, connectorCases, live, needsRelay, routineFiles, suites } from '../test/e2e/suites.mjs'

const usage = 'node scripts/e2e.mjs [--case E0|--suite release|all|live-connectors|live-routines] [--artifact <tgz>] [--previous <tgz>] [--report-dir <output>]\n' +
  '  [--strict [--allow-skip <case> ... --waiver-reason <text>]] [--retries <0-3>]\n\n' +
  '--strict      a skipped case fails the run unless --allow-skip names it (a release verdict needs --strict)\n' +
  '--retries n   run a failed case again on the same archive, up to n more times; every attempt stays in the report'

const { values } = parseArgs({ options: {
  case: { type: 'string' }, suite: { type: 'string' }, artifact: { type: 'string' },
  previous: { type: 'string' }, 'report-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  strict: { type: 'boolean' }, retries: { type: 'string' }, 'allow-skip': { type: 'string', multiple: true }, 'waiver-reason': { type: 'string' },
} })
if (values.help) {
  console.log(usage)
} else {
  if (values.case && values.suite) throw new Error('Select a case or a suite')
  // E12 upgrades from the 0.1.0 build committed at this revision (the two-roster
  // cutover); clones without that commit, such as the public history, skip it.
  // UPGRADE-PREVIOUS upgrades from --previous: the release tool passes the newest
  // published archive.
  const upgradeBaseline = '71e8cac'
  const hasRevision = revision => {
    try {
      execFileSync('git', ['cat-file', '-e', revision + '^{commit}'], { cwd: repository, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if ((values.case && ![...all, ...live, ...androidCases].includes(values.case)) || (values.suite && !Object.hasOwn(suites, values.suite))) throw new Error('Unknown case or suite')
  const cases = values.case ? [values.case] : suites[values.suite ?? 'release']
  const retries = values.retries === undefined ? 0 : Number(values.retries)
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new Error('--retries takes a whole number from 0 to 3')
  const allowSkip = [...new Set(values['allow-skip'] ?? [])]
  const waiverReason = values['waiver-reason']?.trim() ?? ''
  if (allowSkip.length && !values.strict) throw new Error('--allow-skip only applies with --strict')
  if (allowSkip.length && !waiverReason) throw new Error('--allow-skip needs --waiver-reason saying why the case may be skipped')
  for (const id of allowSkip) if (!cases.includes(id)) throw new Error('--allow-skip names a case this run does not include: ' + id)
  const reportDir = values['report-dir'] ? resolve(values['report-dir']) : await mkdtemp(join(tmpdir(), 'godbot-e2e-report-'))
  await mkdir(reportDir, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(tmpdir(), 'godbot-e2e-'))
  const report = { startedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    platform: process.platform + '-' + process.arch, versions: installedVersions(), cases: cases.map(id => ({ id, status: 'not-run', evidence: [] })),
    strict: values.strict === true, retries, waived: allowSkip.map(id => ({ id, reason: waiverReason })),
    level: values.case === 'SANDBOX-SETUP' ? 'packaged DSH Web / browser / disposable Lima guest and provider CLI'
      : androidCases.includes(values.case) ? 'packaged Android app / emulator / relay / packaged DSH Web / fixture agents'
      : cases.some(id => live.includes(id)) ? 'packaged DSH Web / browser / authenticated native CLI / local test application' : 'packaged DSH Web / browser / fixture models' }
  if (process.env.GODBOT_RELAY_BIN) {
    let version = null
    try { version = execFileSync(process.env.GODBOT_RELAY_BIN, ['version'], { encoding: 'utf8', timeout: 10_000 }).trim() } catch { /* reported as unknown */ }
    report.relay = { version }
  }
  await saveEvidence(reportDir, 'report.json', report)
  let browser
  try {
    const candidate = values.artifact ? await inspectArchive(values.artifact) : await buildArchive(scratch)
    report.archive = { sha256: candidate.sha256, buildId: candidate.buildId, version: candidate.version }
    const previous = values.previous ? await inspectArchive(values.previous) : undefined
    const legacy = cases.includes('E12') && hasRevision(upgradeBaseline) ? await buildArchive(scratch, upgradeBaseline) : undefined
    if (previous) report.previous = { sha256: previous.sha256, buildId: previous.buildId, version: previous.version }
    if (legacy) report.legacyBaseline = { revision: upgradeBaseline, sha256: legacy.sha256, buildId: legacy.buildId, version: legacy.version }
    const launch = await openBrowser()
    browser = launch.browser
    report.browser = { engine: browser.browserType().name(), version: browser.version(), source: launch.source }
    console.log('Browser: ' + report.browser.engine + ' ' + report.browser.version + ' (' + launch.source + ')')

    // One run of a scenario. Each attempt gets its own evidence folder: the first
    // keeps the case's name, a retry adds .attempt-<n>, so a failure is never
    // overwritten by the rerun that followed it.
    const attempt = async (row, file, number) => {
      const { id } = row
      const dir = join(reportDir, number === 1 ? id : id + '.attempt-' + number)
      await mkdir(dir, { recursive: true })
      const evidence = []
      const record = { attempt: number, status: 'not-run', startedAt: new Date().toISOString() }
      row.attempts.push(record)
      row.evidence = evidence
      const note = (event, detail) => evidence.push({ event, time: new Date().toISOString(), ...detail })
      const hosts = []
      try {
        console.log('Running ' + id + (number > 1 ? ' (attempt ' + number + ')' : ''))
        const check = (await import(file)).default
        if (typeof check !== 'function') throw new Error('Missing case implementation')
        const makeHost = async (options = {}) => {
          const host = await createHost({ scratch, browser, reportDir: dir, note }, options)
          hosts.push(host)
          return host
        }
        await check({ makeHost, candidate, previous: id === 'E12' ? legacy : previous, reportDir: dir, scratch, note, scenario: id })
        if (!evidence.some(item => item.event === 'started' && item.buildId === candidate.buildId && item.clientSha256 === candidate.clientSha256)) {
          throw new Error('Scenario did not load the candidate Host and browser client')
        }
        record.status = 'passed'
      } catch (error) {
        record.status = error instanceof EnvironmentError ? 'environment-failure' : 'failed'
        record.reason = redact(error.stack ?? error)
        console.error(record.reason)
        for (const [index, host] of hosts.entries()) await host.capture('failure-' + index).catch(() => {})
      } finally {
        for (const host of hosts.reverse()) {
          try { await host.close() } catch (error) { record.status = 'environment-failure'; record.cleanupError = redact(error.message) }
        }
        record.endedAt = new Date().toISOString()
        row.status = record.status
        delete row.reason
        delete row.cleanupError
        if (record.reason) row.reason = record.reason
        if (record.cleanupError) row.cleanupError = record.cleanupError
        // Passed only after an earlier attempt failed: the report says so.
        if (row.attempts.length > 1) row.flaky = row.status === 'passed'
        console.log(id + ' ' + row.status + (number > 1 ? ' (attempt ' + number + ')' : ''))
        await saveEvidence(reportDir, 'report.json', report)
      }
    }

    for (const row of report.cases) {
      const { id } = row
      const scenarioFile = connectorCases.includes(id) ? 'live-connectors.mjs' : (routineFiles[id] ?? 'cases/' + id + '.mjs')
      const file = new URL('../test/e2e/' + scenarioFile, import.meta.url)
      // PHONE needs a godbot-server relay binary (renjiegod/godbot-server, go build ./cmd/godbot-relay).
      const skip = !existsSync(file) ? { status: 'not-run', reason: 'Scenario has no implementation' }
        : id === 'E12' && !legacy ? { status: 'skipped', reason: 'The 0.1.0 upgrade baseline ' + upgradeBaseline + ' is not in this checkout' }
        : id === 'UPGRADE-PREVIOUS' && !previous ? { status: 'skipped', reason: 'Pass --previous <tgz>, the newest published archive, to run UPGRADE-PREVIOUS' }
        : id === 'BUNDLED-COMPUTER-HOST' && (process.platform !== 'darwin' || process.arch !== 'arm64') ? { status: 'skipped', reason: 'The bundled host E2E requires an Apple silicon Mac' }
        : needsRelay(id) && !process.env.GODBOT_RELAY_BIN ? { status: 'skipped', reason: 'Set GODBOT_RELAY_BIN to a godbot-relay binary to run ' + id }
        : null
      if (skip) {
        row.status = skip.status
        row.reason = skip.reason
        console.log(skip.reason)
        console.log(id + ' ' + row.status)
        await saveEvidence(reportDir, 'report.json', report)
        continue
      }
      row.attempts = []
      for (let number = 1; ; number++) {
        await attempt(row, file, number)
        if (row.status === 'passed' || number > retries) break
        console.log('Running ' + id + ' again on the same archive (' + (number + 1) + ' of ' + (retries + 1) + ')')
      }
    }
  } catch (error) {
    report.environmentFailure = redact(error.stack ?? error)
    for (const row of report.cases) if (row.status === 'not-run' && !row.reason) row.reason = 'Setup failed before this scenario could run'
    console.error(report.environmentFailure)
  } finally {
    await browser?.close()
    await rm(scratch, { recursive: true, force: true })
    report.endedAt = new Date().toISOString()
    // Without --strict a skipped case does not fail the run, but such a run is no
    // release verdict: scripts/release-candidate.mjs only accepts strict reports.
    const waived = new Set(report.waived.map(item => item.id))
    const blocking = report.cases.filter(row => row.status !== 'passed' && !(row.status === 'skipped' && (!report.strict || waived.has(row.id))))
    report.result = report.environmentFailure || blocking.length || report.cases.length !== cases.length ? 'failed' : 'passed'
    await saveEvidence(reportDir, 'report.json', report)
    const count = status => report.cases.filter(row => row.status === status).length
    console.log('Godbot E2E: ' + report.result + ' (' + count('passed') + ' passed, ' + count('failed') + ' failed, ' +
      count('environment-failure') + ' environment failures, ' + count('skipped') + ' skipped, ' + count('not-run') + ' not run)' + (report.strict ? ', strict' : ''))
    const flaky = report.cases.filter(row => row.flaky).map(row => row.id)
    if (flaky.length) console.log('Passed only on a later attempt: ' + flaky.join(', '))
    if (blocking.length) console.log('Not passed: ' + blocking.map(row => row.id + ' ' + row.status).join(', '))
    if (!report.strict && count('skipped')) console.log('Skipped cases do not fail a run without --strict; this report is not a release verdict')
    console.log('Godbot E2E report: ' + join(reportDir, 'report.json'))
    if (report.result !== 'passed') process.exitCode = 1
  }
}
