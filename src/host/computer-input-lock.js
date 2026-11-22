import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

// Each in-flight Bot action and each human control session creates a unique
// marker before checking for competitors. Two simultaneous contenders may
// both yield, but neither can miss a holder that has already acquired access.
// Records survive a paused process. When available, a process birth stamp
// distinguishes the original holder from a later process with the same PID.
const incompatible = {
  bot: new Set(['human', 'private', 'consent']),
  human: new Set(['human', 'bot', 'private', 'consent']),
  // An offer or trusted settings may only be shown after all capture stops.
  private: new Set(['human', 'bot', 'capture']),
  capture: new Set(['private', 'consent']),
  // A control upgrade can prompt during an already approved view. New capture
  // attempts see this marker and wait until the prompt has been dismissed.
  consent: new Set(['human', 'bot']),
}

let ownBirth
let bootIdentity

function processBirth(pid) {
  try {
    let birth
    if (process.platform === 'linux') {
      const boot = (bootIdentity ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const endOfCommand = stat.lastIndexOf(') ')
      if (endOfCommand < 0) return
      const start = stat.slice(endOfCommand + 2).split(' ')[19]
      if (!boot || !/^\d+$/.test(start ?? '')) return
      birth = `${boot}:${start}`
    } else if (process.platform === 'darwin') {
      // The kernel start time as printed by ps is precise to a second.
      // Reuse in that same second keeps the marker busy conservatively.
      const settings = {
        encoding: 'utf8',
        env: { LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }
      const boot = (bootIdentity ??= execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], settings).trim())
      const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], settings).trim()
      if (!boot || !start) return
      birth = `${boot}:${start}`
    } else {
      return
    }
    return createHash('sha256').update(birth).digest('hex').slice(0, 15)
  } catch {
    // An unavailable process identity cannot establish that a live holder is stale.
  }
}

function newMarkerId() {
  const random = randomUUID()
  const birth = (ownBirth ??= processBirth(process.pid))
  if (!birth) return random
  // Preserve the empty directory and UUID shape used by older readers.
  return `${birth.slice(0, 8)}-${birth.slice(8, 12)}-8${birth.slice(12)}${random.slice(18)}`
}

function markerIsStale(pid, id) {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (err.code === 'ESRCH') return true
    throw err
  }
  if (id[14] !== '8') return false
  const birth = processBirth(pid)
  const recorded = id.slice(0, 8) + id.slice(9, 13) + id.slice(15, 18)
  return birth != null && birth !== recorded
}

export function claimComputerInput(kind, directory = '/tmp/godbot-desktop-input-' + process.getuid()) {
  if (!Object.hasOwn(incompatible, kind)) throw new Error('Unknown computer input owner')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const dir = lstatSync(directory)
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0) {
    throw new Error('Computer input ownership directory is unavailable')
  }
  const name = kind + '.' + process.pid + '.' + newMarkerId()
  const path = join(directory, name)
  mkdirSync(path, { mode: 0o700 })
  let held = true
  const release = () => {
    if (!held) return
    held = false
    try {
      rmdirSync(path)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  try {
    for (const entry of readdirSync(directory)) {
      if (entry === name) continue
      const parts = /^(human|bot|private|capture|consent)\.(\d+)\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(entry)
      if (!parts) throw new Error('Unsupported computer input ownership record')
      if (!incompatible[kind].has(parts[1])) continue
      if (markerIsStale(Number(parts[2]), parts[3])) {
        try {
          rmdirSync(join(directory, entry))
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
        continue
      }
      throw Object.assign(new Error('Another controller is operating this computer'), { code: 'BUSY' })
    }
    return release
  } catch (err) {
    release()
    throw err
  }
}
