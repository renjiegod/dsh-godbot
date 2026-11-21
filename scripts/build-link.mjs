// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Builds src/host/team-runtime/mobile-link.js, the phone link that core/phone.js runs, from the
// shared code in src/link. The phone app copies src/link too, so both ends speak one protocol.
//
//   node scripts/build-link.mjs           writes mobile-link.js
//   node scripts/build-link.mjs --check   exits 1 when mobile-link.js differs from a fresh build
//
// mobile-link.js is committed with its crypto libraries inside, so the plugin installs with no
// dependencies of its own, as client.js does.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const LINK_BUNDLE = join(ROOT, 'src', 'host', 'team-runtime', 'mobile-link.js')

const HEADER = [
  '// Modified for Godbot. See THIRD_PARTY_NOTICES.',
  '// Generated from src/link by `npm run build` (scripts/build-link.mjs). Do not edit by hand.',
].join('\n')

export async function bundleLink() {
  const result = await build({
    absWorkingDir: join(ROOT, 'src', 'link'),
    entryPoints: ['index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'inline',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return `${HEADER}\n${result.outputFiles[0].text}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleLink()
  if (process.argv.includes('--check')) {
    let current = null
    try { current = readFileSync(LINK_BUNDLE, 'utf8') } catch { /* missing counts as stale */ }
    if (current !== next) {
      console.error('mobile-link.js is stale: run `npm run build` and commit the result')
      process.exit(1)
    }
  } else {
    writeFileSync(LINK_BUNDLE, next)
  }
}
