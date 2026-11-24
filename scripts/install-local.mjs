import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { findExecutable } from '../src/drivers/external/discover.js'
import { hostPeerSpecs } from './host-peers.mjs'

const { values, positionals } = parseArgs({ options: { repair: { type: 'boolean' } }, allowPositionals: true })
if (positionals.length > 1) throw new Error('Usage: node scripts/install-local.mjs [profile] [--repair]')
const profile = positionals[0] || 'web'
const root = new URL('../', import.meta.url)
const dsh = findExecutable('dsh')
if (!dsh) throw new Error('Cannot find the DSH executable on PATH')
const plugin = (args, options) => execFileSync(dsh, ['plugin', '--profile', profile, ...args], { cwd: root, ...options })
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

if (values.repair) {
  // Use the installed release's manifest and leave its package reference intact.
  const projects = JSON.parse(plugin(['list', '--depth', '0', '--json', manifest.name], { encoding: 'utf8' }))
  const project = projects.find(row => row.dependencies?.[manifest.name])
  if (!project) throw new Error(`${manifest.name} is not installed in DSH profile ${profile}`)
  const installed = JSON.parse(readFileSync(join(project.path, 'node_modules', manifest.name, 'package.json'), 'utf8'))
  if (installed.name !== manifest.name) throw new Error(`Expected ${manifest.name}, found ${installed.name}`)
  plugin(['add', '--save-exact', ...hostPeerSpecs(installed, dsh)], { stdio: 'inherit' })
  console.log(`Linked the DSH dependencies for ${profile}. Restart DSH to load the repaired profile.`)
} else {
  const peers = hostPeerSpecs(manifest, dsh)
  const archives = join(homedir(), '.local/share/dsh-godbot/packages')
  mkdirSync(archives, { recursive: true, mode: 0o700 })
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--no-foreground-scripts', '--pack-destination', archives], { cwd: root, encoding: 'utf8' }),
  )
  const archive = resolve(archives, pack.filename)
  execFileSync(process.execPath, ['scripts/check-bundled-host-package.mjs', archive], { cwd: root, stdio: 'inherit' })
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex').slice(0, 12)
  const target = archive.replace(/\.tgz$/, '-' + digest + '.tgz')
  renameSync(archive, target)
  // Profile pnpm must be able to resolve the same native peers as the running Host.
  plugin(['add', '--save-exact', target, ...peers], { stdio: 'inherit' })
  console.log(target)
}
