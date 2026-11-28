import { isDeepStrictEqual } from 'node:util'

// Only a prefix of the same interrupted strict release suite can be continued.
// Every reused case finished cleanup and loaded the actual candidate in a browser.
export function completedPrefix(current, prior, clientSha256) {
  if (current.suite !== 'release' || !current.strict || prior?.checkpointVersion !== 1 || prior.environmentFailure) return []
  if ((prior.result || prior.endedAt) && prior.result !== 'interrupted') return []
  const fields = ['suite', 'strict', 'revision', 'archive', 'previous', 'legacyBaseline', 'relay', 'platform', 'osRelease', 'versions', 'browser', 'retries', 'waived']
  if (!current.archive?.sha256 || !current.previous?.sha256 || !current.relay?.sha256 || !current.browser?.version) return []
  if (fields.some(key => !isDeepStrictEqual(prior[key], current[key]))) return []
  if (!Array.isArray(prior.cases) || !isDeepStrictEqual(prior.cases.map(row => row.id), current.cases.map(row => row.id))) return []

  const passed = []
  for (const row of prior.cases) {
    if (row.status === 'not-run' && !row.attempts?.length) continue
    if (prior.result === 'interrupted' && row.status === 'interrupted' && row.attempts?.length === 1 && row.attempts[0].status === 'interrupted') continue
    if (row.id !== current.cases[passed.length].id || row.status !== 'passed') return []
    const attempts = row.attempts
    if (!Array.isArray(attempts) || attempts.length !== 1 || attempts[0].status !== 'passed' || !attempts[0].endedAt) return []
    if (!row.evidence?.some(event => event.event === 'started' && event.buildId === current.archive.buildId && event.clientSha256 === clientSha256)) return []
    passed.push(row)
  }
  return passed
}
