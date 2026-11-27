export const usagePeriods = { today:'今日（UTC）', week:'近 7 天', month:'本月（UTC）' }

export { quotaKind } from '../host/team-runtime/core/local-agents/engines.js'

export function accountConsumption(provider, id) {
  const attribution = id === null ? 'host' : 'sandbox'
  return provider?.accounts?.find(row => row.attribution === attribution && row.accountId === id)
}

export function usageCount(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function quotaPercent(window) {
  if (typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100)
    return { value:window.usedPercent, label:'已用' }
  if (typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100)
    return { value:window.remainingPercent, label:'剩余' }
}

export function quotaWindowLabel(source, window) {
  const label = window.label || window.id
  if (source === 'antigravity-statusline') {
    const match = /^(gemini|3p)-(5h|weekly)$/u.exec(window.id)
    if (match) return (match[1] === 'gemini' ? 'Gemini' : '第三方模型') + ' · ' + (match[2] === '5h' ? '5 小时' : '7 天')
  }
  const minutes = window.windowMinutes
  if (source === 'codex-app-server' && Number.isSafeInteger(minutes) && minutes > 0) {
    const duration = minutes % 1440 === 0 ? minutes / 1440 + ' 天' : minutes % 60 === 0 ? minutes / 60 + ' 小时' : minutes + ' 分钟'
    return label.replace(/ · (?:主要|次要)窗口$/u,'') + ' · ' + duration
  }
  return label
}

export function localTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
}

export function usageProviders(providers = [], period = 'week') {
  const activity = provider => Boolean(provider.periods?.[period]?.reports || provider.periods?.[period]?.unreported)
  return providers.toSorted((a,b) => Number(activity(b)) - Number(activity(a))
    || (b.periods?.[period]?.tokens ?? 0) - (a.periods?.[period]?.tokens ?? 0)
    || Number(Boolean(b.available)) - Number(Boolean(a.available))
    || a.name.localeCompare(b.name, 'en') || a.route.localeCompare(b.route, 'en'))
}

// The account a local agent runs with, as one short label.
export function accountText(accountId, name) {
  if (accountId === null || accountId === undefined) return name ? name + '（本机）' : '本机账号'
  return '沙箱账号 · ' + (name || accountId)
}

const active = totals => Boolean(totals?.reports || totals?.unreported)
const byTokens = (a, b) => (b.totals.tokens ?? 0) - (a.totals.tokens ?? 0) || (b.totals.unreported ?? 0) - (a.totals.unreported ?? 0)
  || a.key.localeCompare(b.key, 'en')

// One Bot's usage by the agent and account each call ran on, busiest first.
export function botAgentRows(usage, period) {
  const rows = []
  for (const provider of usage?.providers ?? []) {
    for (const account of provider.accounts ?? []) {
      const totals = account.periods?.[period]
      if (!active(totals)) continue
      const accountId = account.attribution === 'sandbox' ? account.accountId : null
      rows.push({ key: provider.route + '\n' + (accountId ?? ''), route: provider.route, name: provider.name ?? provider.route,
        account: accountText(accountId, account.name), totals })
    }
  }
  return rows.sort(byTokens)
}

// One Bot's usage by model, whichever account served it, busiest first. A model
// names its agent when the Bot used more than one.
export function botModelRows(usage, period) {
  const rows = new Map()
  for (const provider of usage?.providers ?? []) {
    for (const account of provider.accounts ?? []) {
      for (const model of account.models ?? []) {
        const totals = model.periods?.[period]
        if (!active(totals)) continue
        const key = provider.route + '\n' + (model.model ?? '')
        const row = rows.get(key) ?? { key, route: provider.route, agent: provider.name ?? provider.route, model: model.model ?? null,
          totals: { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reports: 0, unreported: 0 } }
        for (const field of Object.keys(row.totals)) row.totals[field] += Number.isFinite(totals[field]) ? totals[field] : 0
        rows.set(key, row)
      }
    }
  }
  const list = [...rows.values()].sort(byTokens)
  const several = new Set(list.map(row => row.route)).size > 1
  return list.map(row => ({ ...row, label: (row.model || '未标记模型') + (several ? ' · ' + row.agent : '') }))
}

export function usageDetail(route, settings, consumption) {
  if (!route) return undefined
  return settings.find(row=>row.route===route)
    ?? (consumption?.route === route ? { route, name: consumption.name ?? route, archived: consumption.archived === true } : undefined)
}
