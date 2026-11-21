import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cleanEnv, findExecutable } from '../drivers/external/discover.js'
import { checkSandboxProviderIdentity, listSandboxAccounts, sandboxProviderBinding } from './sandbox-accounts.js'
import { sandboxAccountsEnabled } from './sandbox-settings.js'

const exec = promisify(execFile)
const nativeCommands = { antigravity: 'agy', claude: 'claude', codex: 'codex' }
const loginArgs = { antigravity: ['acp', '--login'], claude: ['auth', 'login'], codex: ['login', '--device-auth'] }
const kinds = Object.keys(nativeCommands)
const probeFile = fileURLToPath(new URL('./provider-accounts-probe.py', import.meta.url))
const godbotCli = fileURLToPath(new URL('../../bin/godbot.mjs', import.meta.url))
const pathFor = stateDir => join(stateDir, 'provider-accounts.json')
const localKey = '@local'
const emptyIdentity = () => ({ status: 'unchecked', email: null, checkedAt: null })

function read(stateDir) {
  try {
    const stored = JSON.parse(readFileSync(pathFor(stateDir), 'utf8'))
    if (stored?.version !== 1 || !stored.providers || typeof stored.providers !== 'object')
      throw new Error('Invalid provider account settings')
    for (const provider of Object.values(stored.providers)) {
      if (!provider || typeof provider.accounts !== 'object' || !provider.accounts)
        throw new Error('Invalid provider account settings')
      provider.accounts = Object.assign(Object.create(null), provider.accounts)
    }
    return stored
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, providers: {} }
    throw error
  }
}

function update(stateDir, kind, change) {
  // The profile Store grants one Host the write lease. Read again after asynchronous
  // checks so a newly edited name/default is never replaced with an older snapshot.
  const data = read(stateDir)
  const provider = data.providers[kind] ??= { accounts: Object.create(null), defaultAccountId: null }
  change(provider)
  const path = pathFor(stateDir), tmp = path + '.' + randomUUID()
  try {
    writeFileSync(tmp, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function nativeProgram(kind, config) {
  const program = findExecutable(config?.[kind]?.command || nativeCommands[kind])
  if (!program) return null
  try { accessSync(program, constants.X_OK); return program } catch { return null }
}

function nativeBinding(program, config) {
  const env = config?.env ?? {}
  const directories = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME'].map(k => env[k] ?? process.env[k])
  return createHash('sha256').update(JSON.stringify([program, ...directories])).digest('hex')
}

function row(id, slot, provider, binding, available) {
  const account = provider?.accounts?.[id ?? localKey]
  const observation = account?.identity
  const identity = observation && observation.binding === binding
    ? { status: observation.status, email: observation.email, checkedAt: observation.checkedAt } : emptyIdentity()
  const customName = account?.customName || null
  return { id, slotName: slot?.name ?? '本机默认', name: customName ?? identity.email ?? slot?.name ?? '本机默认',
    customName, local: id === null, managed: id === null || account?.managed === true, removed: account?.removed === true, available,
    identity, workspaces: slot?.workspaces ?? [] }
}

export function providerAccounts(stateDir, config, inUse = () => false) {
  const enabled = sandboxAccountsEnabled(stateDir)
  const slots = enabled ? listSandboxAccounts() : []
  const { providers } = read(stateDir)
  return { enabled, providers: kinds.map(kind => {
    const provider = providers[kind]
    const program = nativeProgram(kind, config)
    const accounts = [row(null, null, provider, nativeBinding(program, config?.[kind]), !!program)]
    for (const slot of slots.filter(s => s.kinds.includes(kind)))
      accounts.push(row(slot.id, slot, provider, sandboxProviderBinding(slot.id, kind), true))
    for (const account of accounts) account.inUse = !account.removed && inUse(kind, account.id)
    const defaultAccountId = enabled ? provider?.defaultAccountId ?? null : null
    const defaultAvailable = defaultAccountId === null || (accounts.some(a => a.id === defaultAccountId && !a.removed) &&
      (!provider.defaultBinding || provider.defaultBinding === sandboxProviderBinding(defaultAccountId, kind)))
    return { kind, defaultAccountId, defaultAvailable, accounts }
  }) }
}

export function getDefaultProviderAccount(stateDir, kind) {
  if (!Object.hasOwn(nativeCommands, kind) || !sandboxAccountsEnabled(stateDir)) return null
  const provider = read(stateDir).providers[kind]
  if (!provider?.defaultAccountId) return null
  const slot = listSandboxAccounts().find(s => s.id === provider.defaultAccountId && s.kinds.includes(kind))
  if (!slot || provider.accounts[slot.id]?.removed ||
      (provider.defaultBinding && provider.defaultBinding !== sandboxProviderBinding(slot.id, kind)))
    throw new Error('首选沙箱账号已不可用，请在本地 Agent 设置中选择其他账号或本机默认。')
  const info = row(slot.id, slot, provider, sandboxProviderBinding(slot.id, kind), true)
  return { id: info.id, name: info.name, workspaces: info.workspaces }
}

export function assertProviderAccountSelectable(stateDir, kind, id) {
  if (id != null && read(stateDir).providers[kind]?.accounts?.[id]?.removed)
    throw new Error('该账号已从此 Agent 移出，请先重新添加。')
}

function target(stateDir, kind, id, config) {
  if (!Object.hasOwn(nativeCommands, kind)) throw new Error('请选择支持的 Agent。')
  if (id === null) {
    const program = nativeProgram(kind, config)
    return { program, binding: nativeBinding(program, config?.[kind]) }
  }
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw new Error('请选择有效的运行账号。')
  if (!sandboxAccountsEnabled(stateDir)) throw new Error('请先在设置中启用多账号沙箱。')
  return { binding: sandboxProviderBinding(id, kind) }
}

export function providerUsageTarget(stateDir, kind, id, config) {
  const selected = target(stateDir, kind, id, config)
  const account = read(stateDir).providers[kind]?.accounts?.[id ?? localKey]
  if (account?.removed) throw new Error('该账号已从此 Agent 移出，请先重新添加。')
  const identity = account?.identity
  return { ...selected, binding: selected.binding + ':' + (account?.usageEpoch ?? ''),
    identity: identity?.binding === selected.binding ? identity : null }
}

function shellArg(value) {
  return /^[A-Za-z0-9_/.:=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'"
}

async function openLoginTerminal(command) {
  if (process.platform !== 'darwin') return false
  const source = ['on run argv', 'tell application "Terminal"', 'activate',
    'do script (item 1 of argv)', 'end tell', 'end run'].join('\n')
  try {
    // The AppleScript is constant. Only the already-quoted trusted launch plan is an argument.
    await exec('/usr/bin/osascript', ['-e', source, '--', command], { timeout: 12000, maxBuffer: 4096 })
    return true
  } catch { return false }
}

function projection(result) {
  if (!['signed-in', 'signed-out', 'unavailable'].includes(result?.status)) return { status: 'unavailable', email: null }
  const email = result.email
  return { status: result.status, email: result.status === 'signed-in' && typeof email === 'string' &&
    email.length <= 254 && /^[^\s@\x00-\x1f<>]+@[^\s@\x00-\x1f<>]+\.[^\s@\x00-\x1f<>]+$/u.test(email) ? email : null }
}

async function checkNative(kind, program, config) {
  const python = program && findExecutable('python3')
  if (!python) return { status: 'unavailable' }
  const { stdout } = await exec(python, ['-I', probeFile, kind, program], { cwd: homedir(),
    env: cleanEnv(config?.[kind]?.env), timeout: 30000, maxBuffer: 8192 })
  return JSON.parse(stdout)
}

export class ProviderAccounts {
  constructor(stateDir, config, { openTerminal = openLoginTerminal, inUse = () => false } = {}) {
    this.stateDir = stateDir
    this.config = config
    this.openTerminal = openTerminal
    this.inUse = inUse
    this.pending = new Map()
  }
  view() { return providerAccounts(this.stateDir, this.config, this.inUse) }

  async close() {
    await Promise.allSettled(this.pending.values())
  }

  dispatch(req) {
    if (req.action === 'provider-accounts') return this.view()
    const { kind, accountId: id } = req
    const selected = target(this.stateDir, kind, id, this.config)
    const key = id ?? localKey
    const previous = read(this.stateDir).providers[kind]?.accounts?.[key]
    if (previous?.removed && req.action !== 'provider-account-save' && req.action !== 'provider-account-remove')
      throw new Error('该账号已从此 Agent 移出，请先重新添加。')
    if (req.action === 'provider-account-login') {
      if (id === null && !selected.program) throw new Error('此宿主尚未安装相应的 CLI。')
      const args = id === null ? [selected.program, ...loginArgs[kind]] : [godbotCli, 'sandbox', 'login', id, kind]
      const names = kind === 'claude' ? ['CLAUDE_CONFIG_DIR'] : kind === 'codex' ? ['CODEX_HOME'] : []
      const env = id === null
        ? names.map(k => [k, this.config?.[kind]?.env?.[k] ?? process.env[k]])
        : [['GODBOT_SANDBOX_ACCOUNTS_DIR', process.env.GODBOT_SANDBOX_ACCOUNTS_DIR]]
      const settings = env.filter(([, value]) => typeof value === 'string' && value.length).map(([k, v]) => k + '=' + v)
      const command = [...(settings.length ? ['/usr/bin/env', ...settings] : []), ...args].map(shellArg).join(' ')
      if (req.open !== true) return { command, opened: false }
      // A deliberate sign-in can replace the provider identity without changing
      // the VM or native CLI path. Retire the old identity and quota observations.
      update(this.stateDir, kind, provider => {
        const account = provider.accounts[key] ??= {}
        account.usageEpoch = randomUUID()
        delete account.identity
      })
      return this.openTerminal(command).then(opened => ({ command, opened }))
    }
    if (req.action === 'provider-account-check') {
      const task = kind + ':' + key + ':' + (previous?.usageEpoch ?? '')
      if (this.pending.has(task)) return this.pending.get(task)
      const request = this.check(kind, id, selected, previous?.usageEpoch).finally(() => this.pending.delete(task))
      this.pending.set(task, request)
      return request
    }
    if (req.action === 'provider-account-save') {
      if (typeof req.name !== 'string' || req.name.trim().length > 120 || /[\x00-\x1f\x7f]/u.test(req.name))
        throw new Error('账号显示名称最多 120 个字符。')
      update(this.stateDir, kind, provider => {
        const account = provider.accounts[key] ??= {}
        account.managed = true
        delete account.removed
        account.customName = req.name.trim() || null
      })
    } else if (req.action === 'provider-account-remove') {
      if (id === null) throw new Error('本机默认环境不能移出。')
      update(this.stateDir, kind, provider => {
        const account = provider.accounts[id] ??= {}
        account.managed = false
        account.removed = true
        account.usageEpoch = randomUUID()
        if (provider.defaultAccountId === id) {
          provider.defaultAccountId = null
          delete provider.defaultBinding
        }
      })
    } else if (req.action === 'provider-account-default') {
      update(this.stateDir, kind, provider => {
        provider.defaultAccountId = id
        if (id === null) delete provider.defaultBinding
        else provider.defaultBinding = selected.binding
        if (id !== null) (provider.accounts[id] ??= {}).managed = true
      })
    } else throw new Error('Unsupported provider account action')
    return this.view()
  }

  async check(kind, id, selected, epoch) {
    let result
    try {
      result = id === null ? await checkNative(kind, selected.program, this.config) : await checkSandboxProviderIdentity(id, kind)
    } catch { result = { status: 'unavailable' } }
    const current = target(this.stateDir, kind, id, this.config)
    if (current.binding !== selected.binding) throw new Error('检查期间账号绑定已改变，请重试。')
    update(this.stateDir, kind, provider => {
      const account = provider.accounts[id ?? localKey] ??= {}
      if (account.removed) throw new Error('检查期间账号已被移出。')
      if (account.usageEpoch !== epoch) throw new Error('检查期间登录环境已改变，请重试。')
      account.identity = { ...projection(result), checkedAt: new Date().toISOString(), binding: selected.binding }
    })
    return this.view()
  }
}
