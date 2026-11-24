import semver from 'semver'

// DSH's plugin manager includes prereleases when it evaluates engines.dsh.
export function satisfiesDshRange(version, range) {
  return typeof range === 'string' && range.trim() !== ''
    && semver.satisfies(version, range, { includePrerelease: true })
}

export function verifiedDshVersion(manifest) {
  const range = manifest.engines?.dsh
  const target = manifest.godbot?.verifiedDsh ?? range
  if (typeof target !== 'string') return null
  const version = semver.valid(target)
  return version && satisfiesDshRange(version, range) ? version : null
}
