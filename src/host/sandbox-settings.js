// Per DSH profile. Local accounts and their credentials belong to their CLI.
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listSandboxAccounts } from './sandbox-accounts.js'

export function sandboxAccountsEnabled(stateDir) {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, 'sandbox-settings.json'), 'utf8'))
    if (typeof value.enabled !== 'boolean') throw new Error('Invalid sandbox account setting')
    return value.enabled
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function sandboxSettings(stateDir) {
  const enabled = sandboxAccountsEnabled(stateDir)
  return { enabled, accounts: enabled ? listSandboxAccounts() : [] }
}

export function setSandboxEnabled(stateDir, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable sandbox accounts')
  // Disabling must also work if an account manifest has been removed or damaged.
  const accounts = enabled ? listSandboxAccounts() : []
  const path = join(stateDir, 'sandbox-settings.json')
  const tmp = path + '.' + randomUUID()
  try {
    writeFileSync(tmp, JSON.stringify({ enabled }) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
  return { enabled, accounts }
}
