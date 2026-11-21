import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { hostPeerSpecs } from './host-peers.mjs'

const profile = process.argv[2] || 'web'
const root = new URL('../', import.meta.url)
const archives = join(homedir(), '.local/share/dsh-godbot/packages')
mkdirSync(archives, { recursive: true, mode: 0o700 })
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', archives], { cwd: root, encoding: 'utf8' }),
)
const archive = resolve(archives, pack.filename)
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex').slice(0, 12)
const target = archive.replace(/\.tgz$/, '-' + digest + '.tgz')
renameSync(archive, target)
// Profile pnpm must be able to resolve the same native peers as the running Host.
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const peers = hostPeerSpecs(pkg)
execFileSync('dsh', ['plugin', '--profile', profile, 'add', '--save-exact', target, ...peers], { cwd: root, stdio: 'inherit' })
console.log(target)
