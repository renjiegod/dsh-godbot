// Modified for Godbot. See THIRD_PARTY_NOTICES.
export const STORAGE = {
  unread: 'godbot:unread',
  reactions: 'godbot:reactions',
  seen: 'godbot:seen',
  prefs: 'godbot:prefs',
  agentSessions: 'godbot:agent-sessions',
  browserWidth: 'godbot:browser-width',
  sidebar: 'godbot:sidebar',
  dismissedUpdate: 'godbot:dismissed-update',
  browsers: 'godbot.browser.v2',
  notify: 'godbot:notify',
}

const migrationKey = 'godbot:storage-v1'
const previousPrefixes = ['ds-bot:', 'dsh-bot:', 'dsh-bot-team:']

function savedTabs(storage) {
  const tabs = storage.getItem('ds-bot.browser.v2')
  if (tabs !== null) return tabs
  for (const key of ['ds-bot.browser.v1', 'dsh-bot.browser.v1']) {
    try {
      const pages = JSON.parse(storage.getItem(key))
      if (!pages || typeof pages !== 'object') continue
      const entries = Object.entries(pages).filter(([, page]) => page && typeof page === 'object')
      return JSON.stringify(Object.fromEntries(entries.map(([botId, page]) => {
        const tab = { id: `v1-${botId}`, url: page.url ?? '', title: page.title ?? '' }
        return [botId, { tabs: [tab], active: tab.id }]
      })))
    } catch { /* Try the next saved format. */ }
  }
  return null
}

// Copy once so older installations on the same DSH origin keep their own data.
// Written values win if a migration is interrupted between keys.
export function migrateStorage(storage) {
  try {
    storage ??= globalThis.localStorage
    if (storage.getItem(migrationKey) === '1') return
    for (const key of Object.values(STORAGE)) {
      if (storage.getItem(key) !== null) continue
      let value = null
      if (key === STORAGE.browsers) {
        value = savedTabs(storage)
      } else {
        const name = key.slice('godbot:'.length)
        for (const prefix of previousPrefixes) {
          value = storage.getItem(prefix + name)
          if (value !== null) break
        }
      }
      if (value !== null) storage.setItem(key, value)
    }
    const prefs = JSON.parse(storage.getItem(STORAGE.prefs) ?? 'null')
    if (prefs?.theme === 'grok') storage.setItem(STORAGE.prefs, JSON.stringify({ ...prefs, theme: 'mono' }))
    storage.setItem(migrationKey, '1')
  } catch { /* Browser storage may be disabled. */ }
}
