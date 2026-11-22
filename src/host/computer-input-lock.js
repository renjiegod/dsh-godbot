import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

// Each in-flight Bot action and each human control session creates a unique
// marker before checking for competitors. Two simultaneous contenders may
// both yield, but neither can miss a holder that has already acquired access.
// Records survive a paused process and disappear when a crashed PID is reaped.
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
export function claimComputerInput(kind, directory = '/tmp/godbot-desktop-input-' + process.getuid()) {
  if (!Object.hasOwn(incompatible, kind)) throw new Error('Unknown computer input owner')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const dir = lstatSync(directory)
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0) {
    throw new Error('Computer input ownership directory is unavailable')
  }
  const name = kind + '.' + process.pid + '.' + randomUUID()
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
      const parts = /^(human|bot|private|capture|consent)\.(\d+)\.([a-f0-9-]{36})$/.exec(entry)
      if (!parts) throw new Error('Unsupported computer input ownership record')
      if (!incompatible[kind].has(parts[1])) continue
      try {
        process.kill(Number(parts[2]), 0)
      } catch (err) {
        if (err.code !== 'ESRCH') throw err
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
