import { workspaceHome } from './workspace-home.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sandboxRouteInfo } from './team-runtime/sandbox-agents.js'
import { quotaKind } from './team-runtime/core/local-agents/engines.js'

const dayMs = 86_400_000
const counters = ['input', 'cacheRead', 'cacheWrite', 'output']
const iso = value => new Date(value).toISOString()
const totals = () => ({ tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reports: 0, unreported: 0 })
const periods = () => ({ today: totals(), week: totals(), month: totals() })
const isCount = value => Number.isSafeInteger(value) && value >= 0

function identify(row) {
  const { provider } = row
  if (typeof provider !== 'string') return
  const sandbox = sandboxRouteInfo(provider)
  if (sandbox) return { route: sandbox.base, accountId: sandbox.accountId, attribution: 'sandbox' }
  // Godbot records the full route for ordinary calls and manual compaction.
  if (provider.startsWith('local-') && !provider.startsWith('local-sandbox-'))
    return { route: provider, accountId: null, attribution: 'host' }
}

function add(target, row) {
  if (row.missing || !counters.some(key => isCount(row[key]))) {
    target.unreported++
    return
  }
  target.reports++
  for (const key of counters) {
    if (!isCount(row[key])) continue
    target[key] += row[key]
    target.tokens += row[key]
  }
}

function readLedger(file, since, now) {
  if (!existsSync(file)) return { status: 'not-created', rows: [] }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calls'").get())
      return { status: 'not-created', rows: [] }
    // The Session a call served, and the owner the journal recorded for it, name the
    // Bot it belongs to. A ledger written before those columns still counts.
    const session = db.prepare("SELECT 1 FROM pragma_table_info('calls') WHERE name='session'").get() !== undefined
    const owners = session && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owners'").get() !== undefined
    const rows = db.prepare(`SELECT c.key AS id, c.time, c.provider, c.model, c.input, c.output,
        c.cache_read AS cacheRead, c.cache_write AS cacheWrite${session ? ', c.session' : ''}${owners ? ', o.owner' : ''}
        FROM calls c${owners ? ' LEFT JOIN owners o ON o.session = c.session' : ''}
        WHERE c.provider LIKE 'local-%' AND c.time BETWEEN ? AND ?`).all(since, now)
    return { status: 'ready', rows }
  } catch {
    return { status: 'unavailable', rows: [] }
  } finally {
    db?.close()
  }
}

function measuredRows(service, since, now) {
  const file = join(service.runtime?.home ?? workspaceHome(service.stateDir), 'usage.sqlite')
  const ledger = readLedger(file, since, now)
  const rows = new Map(ledger.rows.map(row => [row.id, row]))
  const receipts = service.store.db.prepare(`SELECT data FROM records
    WHERE collection IN ('usageReceipts', 'localUsageGaps') AND json_extract(data, '$.time') BETWEEN ? AND ?`)
  for (const { data } of receipts.iterate(since, now)) {
    const row = JSON.parse(data)
    // The live overlay and the journal share session#turn:step:attempt keys.
    // In either order, a missing-usage placeholder yields to a measurement.
    if (!row.missing || !rows.has(row.id)) rows.set(row.id, row)
  }
  return { rows, ledgerStatus: ledger.status }
}

// The Bot a call belongs to. The live team decides first, as on the Usage page: its own
// chat and earlier parts, and its Sessions in group chats. The owner journaled with the
// call covers Sessions the team no longer lists, such as forks.
function ownerOf(rt, row) {
  const key = typeof row.id === 'string' ? row.id : ''
  const session = typeof row.session === 'string' && row.session !== '' ? row.session
    : key.includes('#') ? key.slice(0, key.indexOf('#')) : undefined
  return (session === undefined ? undefined : rt?.selfOf?.(session)) ?? (typeof row.owner === 'string' && row.owner !== '' ? row.owner : undefined)
}

function publicProvider(provider) {
  const accounts = [...provider.accounts.values()].sort((a, b) =>
    a.attribution.localeCompare(b.attribution) || (a.accountId ?? '').localeCompare(b.accountId ?? ''))
  return {
    ...provider,
    accounts: accounts.map(account => ({
      ...account,
      models: [...account.models.values()].sort((a, b) => (a.model ?? '').localeCompare(b.model ?? '')),
    })),
  }
}

// `botId` keeps only that Bot's calls; without it every local agent call counts.
export function localProviderUsage(service, now = Date.now(), { botId } = {}) {
  const stamp = new Date(now)
  const today = Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate())
  const from = { today, week: now - 7 * dayMs, month: Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth(), 1) }
  const historyStart = today - 6 * dayMs
  const history = () => Array.from({ length: 7 }, (_, i) => ({
    date: iso(historyStart + i * dayMs).slice(0, 10), ...totals(),
  }))
  const { rows, ledgerStatus } = measuredRows(service, Math.min(...Object.values(from)), now)
  const providers = new Map()
  const combined = periods()
  const days = history()
  for (const row of rows.values()) {
    if (botId !== undefined && ownerOf(service.runtime, row) !== botId) continue
    const identity = identify(row)
    if (!identity) continue
    const { route, accountId, attribution } = identity
    if (!providers.has(route))
      providers.set(route, { route, periods: periods(), history: history(), accounts: new Map() })
    const provider = providers.get(route)
    const key = attribution === 'sandbox' ? 'sandbox/' + accountId : attribution
    if (!provider.accounts.has(key))
      provider.accounts.set(key, { accountId, attribution, periods: periods(), models: new Map(), history: history() })
    const account = provider.accounts.get(key)
    const name = typeof row.model === 'string' && row.model ? row.model : null
    if (!account.models.has(name)) account.models.set(name, { model: name, periods: periods() })
    const model = account.models.get(name)
    for (const [period, start] of Object.entries(from)) {
      if (row.time < start) continue
      for (const entry of [provider, account, model]) add(entry.periods[period], row)
      add(combined[period], row)
    }
    if (row.time >= historyStart) {
      const index = Math.floor((row.time - historyStart) / dayMs)
      add(provider.history[index], row)
      add(account.history[index], row)
      add(days[index], row)
    }
  }
  return {
    asOf: iso(now), ledgerStatus,
    periods: Object.fromEntries(Object.entries(from).map(([key, start]) => [key, { start: iso(start), end: iso(now) }])),
    totals: combined,
    history: days,
    providers: [...providers.values()].sort((a, b) => a.route.localeCompare(b.route)).map(publicProvider),
  }
}

// An explicit refresh indexes previous DSH logs through the workspace's existing
// Usage page reader. Its bounded wait reports when that scan is still running.
export async function refreshLocalProviderUsage(service, options) {
  let scanning = false
  let failed = false
  try {
    const rt = service.runtime
    if (rt?.usageView) scanning = Boolean((await rt.usageView({ timeZone: 'UTC' })).scanning)
  } catch {
    failed = true
  }
  const result = localProviderUsage(service, Date.now(), options)
  return { ...result, historyScanning: scanning, ...(failed ? { ledgerStatus: 'unavailable' } : {}) }
}

// An account's display name: the owner's own name for it, else the sandbox's. The host
// CLI's account has none unless the owner named it. No sign-in identity leaves the host.
const accountName = (account, accountId) =>
  account?.customName ?? (accountId === null ? null : account?.slotName ?? accountId)

// One Bot's page: its own local agent calls, wherever it made them, and the agent and
// account it runs on now. Other Bots' calls stay out, even on the same account.
async function botLocalAgentUsage(service, { refreshHistory, botId }) {
  const rt = service.runtime
  await rt.load?.()
  const bot = rt.botOf?.(botId)
  if (bot === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
  const [catalog, usage] = await Promise.all([
    rt.localAgentUsageCatalog(),
    refreshHistory === true ? refreshLocalProviderUsage(service, { botId: bot.id }) : localProviderUsage(service, Date.now(), { botId: bot.id }),
  ])
  const listed = new Map(catalog.map(agent => [agent.route, agent]))
  const environments = new Map((service.providerAccounts?.view().providers ?? []).map(row => [row.kind, row.accounts]))
  const accountOf = (route, accountId) => environments.get(quotaKind(route))?.find(row => row.id === accountId)
  // The agent the Bot runs on now, and its account.
  const provider = rt.localAgentBadge?.(bot.model ?? bot.appliedModel)
  let agent = null
  if (provider !== undefined) {
    const sandbox = sandboxRouteInfo(provider)
    const route = sandbox?.base ?? provider
    const accountId = sandbox?.accountId ?? null
    const account = accountOf(route, accountId)
    agent = {
      route, name: listed.get(route)?.name ?? route, accountId, accountName: accountName(account, accountId),
      available: account === undefined ? accountId === null && listed.get(route)?.installed === true : !account.removed && account.available !== false,
      quotaSupported: quotaKind(route) !== undefined,
    }
  }
  return {
    ...usage,
    bot: { id: bot.id, name: bot.name },
    agent,
    providers: usage.providers.map(row => ({
      ...row, name: listed.get(row.route)?.name ?? row.route, ...(listed.has(row.route) ? {} : { archived: true }),
      accounts: row.accounts.map(account => ({ ...account, name: accountName(accountOf(row.route, account.accountId), account.accountId) })),
    })),
  }
}

export async function localAgentUsageView(service, { refreshHistory, botId } = {}) {
  if (botId !== undefined && botId !== null) {
    if (typeof botId !== 'string' || botId === '') throw Object.assign(new Error('Unknown Bot'), { code: 'bot/invalid' })
    return botLocalAgentUsage(service, { refreshHistory, botId })
  }
  const [catalog, usage] = await Promise.all([
    service.runtime.localAgentUsageCatalog(),
    refreshHistory === true ? refreshLocalProviderUsage(service) : localProviderUsage(service),
  ])
  const accountCatalog = new Map(service.providerAccounts.view().providers.map(row => [row.kind, row.accounts]))
  const byRoute = new Map(usage.providers.map(provider => [provider.route, provider]))
  const providers = catalog.map(agent => {
    const recorded = byRoute.get(agent.route)
    byRoute.delete(agent.route)
    const kind = quotaKind(agent.route)
    const environments = accountCatalog.get(kind)
    const configuredAccounts = environments?.filter(account => !account.removed &&
      (account.local || account.managed || account.inUse || account.identity?.status === 'signed-in'))
      .map(account => ({
        id: account.id, name: account.customName ?? (account.local ? null : account.slotName),
        available: account.available,
      })) ?? [{ id: null, name: null, available: agent.installed }]
    return {
      ...recorded, ...agent, configuredAccounts,
      available: agent.installed || environments?.some(account => !account.removed && account.available) === true,
      quotaSupported: kind !== undefined,
    }
  })
  for (const recorded of byRoute.values()) providers.push({ ...recorded, name: recorded.route, archived: true })
  return { ...usage, providers }
}

export function localAgentQuota(service, { route, accountId = null } = {}) {
  const kind = typeof route === 'string' && quotaKind(route)
  if (!kind) throw Object.assign(new Error('This local agent has no quota source.'), { code: 'bot/invalid' })
  return service.providerUsage.dispatch({ action: 'provider-usage', kind, accountId })
}
