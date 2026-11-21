export const usagePeriods = { today:'今日（UTC）', week:'近 7 天', month:'本月（UTC）' }

export const quotaKind = route => ({
  'local-antigravity':'antigravity', 'local-claude-code':'claude', 'local-codex-cli':'codex', 'local-gemini-cli':'gemini',
})[route]

export function accountConsumption(provider, id) {
  const attribution = id === null ? 'host' : 'sandbox'
  return provider?.accounts.find(row => row.attribution === attribution && row.accountId === id)
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

// Include configured providers even before their first measured turn. A removed
// provider keeps its own ledger identity without becoming a launch choice.
export function usageProviders(settings, measured = [], period = 'week') {
  const byRoute = new Map()
  for (const row of settings) {
    if (row.installed || row.custom || row.accountCount || row.isolated) byRoute.set(row.route,{route:row.route,name:row.name})
  }
  for (const provider of measured) {
    const setting = settings.find(row=>row.route===provider.route)
    byRoute.set(provider.route,{...provider,name:setting?.name || provider.route,archived:!setting})
  }
  return [...byRoute.values()].sort((a,b)=>(b.periods?.[period]?.tokens ?? 0)-(a.periods?.[period]?.tokens ?? 0)
    || a.name.localeCompare(b.name))
}

export function usageDetail(route, settings, consumption) {
  if (!route) return undefined
  return settings.find(row=>row.route===route)
    ?? (consumption?.route === route ? {route,name:route,archived:true} : undefined)
}
