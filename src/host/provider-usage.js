import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { cleanEnv, findExecutable } from '../drivers/external/discover.js'
import { providerUsageTarget } from './provider-accounts.js'
import { checkSandboxProviderUsage } from './sandbox-accounts.js'
import { usageProbeSources } from './provider-usage-sources.js'

const exec = promisify(execFile)
const sources = { codex: 'codex-app-server', antigravity: 'antigravity-statusline', claude: 'claude-usage' }
const reasons = new Set(['not-authenticated', 'not-reported', 'source-unavailable', 'unsupported', 'identity-changed'])
const freshnessMs = 5 * 60000
const hash = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  ? createHash('sha256').update(value).digest('hex') : null
const emailHash = email => hash(typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : '')
const number = (value, max = Infinity) => Number.isFinite(value) && value >= 0 && value <= max ? value : null
const label = (value, max = 96) => typeof value === 'string' && value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() || null : null

function time(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/iu.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function limits(raw) {
  const windows = []
  if (!Array.isArray(raw)) return windows
  for (const item of raw.slice(0, 256)) {
    const id = label(item?.id, 128)
    if (!id) continue
    const usedPercent = number(item.usedPercent, 100), remainingPercent = number(item.remainingPercent, 100)
    const remainingAmount = number(item.remainingAmount), disabled = item.disabled === true
    if (usedPercent == null && remainingPercent == null && remainingAmount == null && !disabled) continue
    windows.push({ id, label: label(item.label) ?? id, usedPercent, remainingPercent, remainingAmount,
      windowMinutes: number(item.windowMinutes), resetsAt: time(item.resetsAt), disabled })
  }
  return windows
}

function balance(raw) {
  if (!raw || typeof raw !== 'object') return null
  const hasCredits = typeof raw.hasCredits === 'boolean' ? raw.hasCredits : null
  const unlimited = typeof raw.unlimited === 'boolean' ? raw.unlimited : null
  const balance = number(raw.balance)
  return [hasCredits, unlimited, balance].every(value => value == null) ? null : { hasCredits, unlimited, balance }
}

function load(stateDir) {
  try {
    const file = JSON.parse(readFileSync(join(stateDir,'provider-usage.json'),'utf8'))
    if (file?.version !== 1 || !file.accounts || typeof file.accounts !== 'object') throw new Error('Invalid provider quota cache')
    return file
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, accounts: {} }
    throw error
  }
}

function save(stateDir, key, value) {
  const data = load(stateDir)
  data.accounts[key] = value
  const file = join(stateDir, 'provider-usage.json'), tmp = file + '.' + randomUUID()
  try {
    writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } finally { rmSync(tmp, { force: true }) }
}

async function nativeUsage(kind, selected, config) {
  const python = selected.program && findExecutable('python3')
  if (!python) return { status: 'unavailable', reason: 'source-unavailable' }
  const [source, ...helpers] = usageProbeSources(kind)
  const { stdout } = await exec(python, ['-I', '-c', source, kind, selected.program, ...helpers], {
    cwd: homedir(), env: cleanEnv(config?.[kind]?.env), timeout: 43000, maxBuffer: 256 * 1024,
  })
  return JSON.parse(stdout)
}

function empty(kind, accountId, source) {
  return { kind, accountId, source, status: 'unchecked', checkedAt: null, updatedAt: null, reason: null, plan: null, windows: [], credits: null }
}

function changedIdentity(identity, snapshot, checkedAt) {
  if (!identity?.checkedAt || identity.checkedAt < checkedAt) return null
  if (identity.status === 'signed-out') return 'not-authenticated'
  const current = emailHash(identity.email)
  return snapshot && current && current !== snapshot.emailHash ? 'identity-changed' : null
}

export class ProviderUsage {
  constructor(stateDir, config, { nativeProviders = {}, now = () => new Date() } = {}) {
    this.stateDir = stateDir
    this.config = config
    this.nativeProviders = nativeProviders
    this.now = now
    this.pending = new Map()
  }
  target(kind, id) {
    if (Object.hasOwn(sources, kind)) return providerUsageTarget(this.stateDir, kind, id, this.config)
    if (id !== null || typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,80}$/.test(kind)) throw new Error('请选择有效的 Agent 和账号。')
    return Object.hasOwn(this.nativeProviders, kind) ? this.nativeProviders[kind].target(this.config) : null
  }
  dispatch({action, kind, accountId}) {
    const selected = this.target(kind, accountId)
    const builtin = Object.hasOwn(sources, kind)
    const adapter = !builtin && Object.hasOwn(this.nativeProviders, kind) ? this.nativeProviders[kind] : null
    const base = empty(kind,accountId,builtin ? sources[kind] : adapter?.source ?? null)
    if (!selected) return { ...base, status:'unavailable', reason:'unsupported' }
    if (typeof selected.binding !== 'string' || !selected.binding) throw new Error('Missing provider account binding')
    const key = kind + ':' + (accountId ?? '@local')
    if (action === 'provider-usage') return this.view(key, selected, base)
    if (action !== 'provider-usage-refresh') throw new Error('Unsupported provider quota action')
    const operation = key + ':' + selected.binding
    if (this.pending.has(operation)) return this.pending.get(operation)
    const request = this.refresh(key, selected, base, adapter).finally(() => this.pending.delete(operation))
    this.pending.set(operation, request)
    return request
  }
  view(key, selected, base) {
    const row = load(this.stateDir).accounts[key]
    if (!row || row.binding !== selected.binding) return base
    const { status, reason, checkedAt, sample } = row
    const conflict = changedIdentity(selected.identity, sample, checkedAt)
    if (conflict) return { ...base, checkedAt, status: conflict === 'not-authenticated' ? 'signed-out' : 'unavailable', reason: conflict }
    if (!sample) return { ...base, status, reason, checkedAt }
    const now = this.now().getTime()
    const resetPassed = sample.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now)
    if (resetPassed || now - Date.parse(checkedAt) >= freshnessMs)
      return { ...base, checkedAt, updatedAt:sample.updatedAt, status:'stale', reason:'expired' }
    return { ...base, checkedAt, updatedAt: sample.updatedAt, plan: sample.plan, credits: sample.credits, windows: sample.windows, status, reason }
  }
  async refresh(key, selected, base, adapter) {
    const { kind, accountId } = base
    let raw
    try {
      if (adapter) raw = await adapter.read(selected, this.config)
      else raw = accountId === null ? await nativeUsage(kind, selected, this.config) : await checkSandboxProviderUsage(accountId, kind)
    } catch { raw = { status:'unavailable', reason:'source-unavailable' } }
    const current = this.target(kind, accountId)
    if (!current || current.binding !== selected.binding) throw new Error('刷新期间账号绑定已改变，请重新选择账号。')
    const previous = load(this.stateDir).accounts[key]
    const checkedAt = this.now().toISOString()
    const windows=limits(raw?.windows), credits=balance(raw?.credits)
    const owner = emailHash(raw?.email), subject = hash(raw?.accountKey) ?? owner
    let status = raw?.status === 'signed-out' ? 'signed-out' : 'unavailable'
    let reason = status === 'signed-out' ? 'not-authenticated' : reasons.has(raw?.reason) ? raw.reason : 'source-unavailable'
    let sample = null
    // Only authenticated native data can replace a sample. The owner identity and workspace
    // scope are hashed, never arbitrary CLI response fields or bearer credentials.
    if (raw?.status === 'available' && (windows.length || credits)) {
      status='available'; reason=null
      sample = { updatedAt: checkedAt, subject, emailHash: owner, plan: label(raw.plan,80), windows, credits }
    } else if (status === 'unavailable' && reason === 'source-unavailable' &&
        subject && previous?.binding === selected.binding && previous.sample?.subject === subject) {
      status='stale'; sample=previous.sample
    }
    if (current.identity?.checkedAt !== selected.identity?.checkedAt && changedIdentity(current.identity, sample, selected.identity?.checkedAt ?? ''))
      throw new Error('刷新期间登录身份已改变。')
    save(this.stateDir,key,{ binding:selected.binding, status, reason, checkedAt, sample })
    return this.view(key,current,base)
  }
  async close() { await Promise.allSettled(this.pending.values()) }
}
