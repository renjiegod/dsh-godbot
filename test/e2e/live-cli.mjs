import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findExecutable } from '../../src/drivers/external/discover.js'
import { EnvironmentError } from './host.mjs'

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export async function installLiveCli(host, binary, { profileDir } = {}) {
  const profileKey = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR' }[binary]
  if (!profileKey) throw new Error('Unsupported live CLI: ' + binary)
  const executable = findExecutable(binary)
  if (!executable) throw new EnvironmentError(binary + ' is not installed')
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 8000 }).trim()
  // Only the vendor CLI sees its existing sign-in. DSH and its fixture model keep the temporary home.
  const exports = ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', ...(profileDir ? [] : [profileKey])]
    .filter(key => process.env[key]).map(key => 'export ' + key + '=' + quote(process.env[key]))
  if (profileDir) exports.push('export ' + profileKey + '=' + quote(profileDir))
  const launcher = ['#!/bin/sh', 'export HOME=' + quote(profileDir ? host.home : homedir()), ...exports,
    'exec ' + quote(executable) + ' "$@"', ''].join('\n')
  await writeFile(join(host.bin, binary), launcher, { mode: 0o700 })
  return { executable, version }
}
