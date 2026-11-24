import { readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { findExecutable } from '../src/drivers/external/discover.js'
import { satisfiesDshRange } from '../src/host/dsh-compatibility.js'

function findHostManifest(executable) {
  const resolveApp = entry => createRequire(realpathSync(entry)).resolve('@deepseek-ai/dsh/package.json')
  try {
    return resolveApp(executable)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  // pnpm and version managers may place a shell shim on PATH. Ask that exact
  // launcher for the entry it hands Node, without starting a server or reading
  // a profile. Another globally installed copy could carry different registries.
  const marker = 'GODBOT_DSH_ENTRY='
  const probe = 'data:text/javascript,' + encodeURIComponent('console.log(' + JSON.stringify(marker) + ' + process.argv[1])')
  const flags = [process.env.NODE_OPTIONS, '--import=' + probe].filter(Boolean).join(' ')
  const output = execFileSync(executable, ['--version'], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: flags }, timeout: 10000,
  })
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.startsWith(marker)) continue
    try { return resolveApp(line.slice(marker.length)) } catch { /* a wrapper process */ }
  }
  throw new Error('Cannot locate the DSH installation launched by ' + executable)
}

// The optional peer declarations keep pnpm's transitive resolution on the
// DSH release track. Profile links use the modules from the DSH installation
// itself to share its scope keys and layer registries.
export function hostPeerSpecs(pkg, executable = findExecutable('dsh')) {
  if (!executable) throw new Error('Cannot find the DSH executable on PATH')
  const manifest = findHostManifest(executable)
  const app = JSON.parse(readFileSync(manifest, 'utf8'))
  const range = pkg.engines?.dsh
  if (!satisfiesDshRange(app.version, range)) throw new Error('Godbot requires DSH ' + range + ', found ' + app.version)
  const fromHost = createRequire(manifest)
  return Object.entries(pkg.peerDependencies ?? {}).map(([name, peerRange]) => {
    const owner = realpathSync(fromHost.resolve(name + '/package.json'))
    const actual = JSON.parse(readFileSync(owner, 'utf8'))
    const hostSupplied = pkg.peerDependenciesMeta?.[name]?.optional === true && name.startsWith('@deepseek-ai/dsh-')
    const expected = hostSupplied ? app.version : peerRange
    if (actual.name !== name || !satisfiesDshRange(actual.version, expected)) {
      throw new Error('Expected ' + name + '@' + expected + ' from ' + manifest + ', found ' + actual.name + '@' + actual.version)
    }
    return name + '@link:' + dirname(owner)
  })
}
