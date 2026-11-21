import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

// Read a single file for a binding the caller has already authorized. Claude
// also searches other projects on resume; reading history must never do that.
export async function openClaudeTranscript({
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  cwd, nativeId,
}, maxBytes) {
  if (typeof nativeId !== 'string' || !uuid.test(nativeId) ||
      typeof cwd !== 'string' || !isAbsolute(cwd) || typeof configDir !== 'string' || !isAbsolute(configDir)) return null
  let file
  try {
    const work = await realpath(cwd)
    const project = work.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-')
    // Longer native folder names use a runtime-dependent hash. Do not search
    // sibling projects or guess a hash when the exact directory is unknown.
    if (project.length > 200) return null
    const root = await realpath(configDir)
    const folder = join(root, 'projects', project)
    if (await realpath(folder) !== folder) return null
    const path = join(folder, nativeId + '.jsonl')
    const entry = await lstat(path)
    if (!entry.isFile() || !entry.size || entry.size > maxBytes) return null
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (stat.isFile() && stat.size >= entry.size && stat.size <= maxBytes &&
        stat.dev === entry.dev && stat.ino === entry.ino && await realpath(folder) === folder)
      return { file, stat, dirs: new Set([resolve(cwd).normalize('NFC'), work.normalize('NFC')]) }
  } catch {
    // A deleted, replaced or unrecognized transcript does not supply history.
  }
  await file?.close().catch(() => {})
  return null
}
