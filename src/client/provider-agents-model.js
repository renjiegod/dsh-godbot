// The team runtime publishes each sandbox account as a callable engine route.
// Those routes are execution targets. The settings list groups them under the CLI.
export const sandboxProviderKinds = {
  'local-antigravity': 'antigravity',
  'local-claude-code': 'claude',
  'local-codex-cli': 'codex',
}

export function providerRows(builtins, discovery, catalog) {
  const byRoute = new Map(builtins.map(agent => [agent.route, { ...agent }]))
  for (const agent of discovery?.detected ?? []) {
    if (agent.sandbox || agent.accountProfileId || agent.route.startsWith('local-sandbox-')) continue
    byRoute.set(agent.route, { ...byRoute.get(agent.route), ...agent, detected: true })
  }
  for (const agent of discovery?.custom ?? []) byRoute.set(agent.route, { ...agent, custom: true })
  for (const row of byRoute.values()) {
    row.kind = sandboxProviderKinds[row.route]
    row.accounts = row.kind && catalog?.providers.find(provider => provider.kind === row.kind)
    row.isolated = row.accounts?.accounts.filter(account => !account.local && !account.removed).length ?? 0
    row.accountCount = row.accounts?.accounts.filter(account => !account.local && !account.removed &&
      (account.inUse || account.managed || account.identity?.status === 'signed-in')).length ?? 0
    row.installed = row.detected === true || row.accounts?.accounts.some(account => account.local && account.available) === true
  }
  return [...byRoute.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

export const signInLabels = {
  unchecked: '尚未核验', 'signed-in': '已登录', 'signed-out': '未登录', unavailable: '无法核验',
}

export function installGuide(kind) {
  switch (kind) {
    case 'antigravity': return 'https://antigravity.google/docs/install'
    case 'claude': return 'https://code.claude.com/docs/en/setup'
    case 'codex': return 'https://developers.openai.com/codex/cli/'
    default: return 'https://agentclientprotocol.com/get-started/registry'
  }
}

// The provider id stored by DSH remains the execution identity. This name is
// used only by the CLI logo and badge tables.
export function displayCli(route) {
  if (typeof route !== 'string' || !route.startsWith('local-')) return undefined
  const match = /^local-sandbox-(antigravity|claude|codex)-[a-z][a-z0-9-]{0,62}(?:_w_[a-f0-9]{16})?$/u.exec(route)
  if (!match) return route.slice('local-'.length)
  return { antigravity:'antigravity',claude:'claude-code',codex:'codex-cli' }[match[1]]
}

export function providerChoices(view, catalog) {
  const detected = view?.detected ?? []
  const rows = detected.filter(row => !row.sandbox && !row.accountProfileId && !row.route.startsWith('local-sandbox-'))
  const names = { antigravity:'Antigravity', claude:'Claude Code', codex:'Codex CLI' }
  for (const [baseRoute,kind] of Object.entries(sandboxProviderKinds)) {
    const index = rows.findIndex(row => row.route === baseRoute)
    const slots = detected.filter(row => row.sandbox && row.kind === kind)
    const provider = catalog?.providers?.find(p => p.kind === kind)
    const preferred = provider?.defaultAccountId
    if (!preferred && !slots.length) continue
    const saved = preferred && provider.defaultAvailable !== false && provider.accounts.find(a => a.id === preferred && a.available && !a.removed)
    const slot = saved && slots.find(row => row.accountProfileId === saved.id)
    let choice
    if (slot && saved.workspaces?.[0]?.hostPath) {
      choice = { route:slot.route, name:names[kind], kind, accountId:saved.id, cwd:saved.workspaces[0].hostPath,
        accountLabel:saved.name, signedIn:saved.identity?.status === 'signed-in' ? true : saved.identity?.status === 'signed-out' ? false : null }
    } else if (!provider || preferred || index < 0) {
      const reason = !provider ? '无法读取运行账号' : preferred ? '默认账号不可用' : '请先选择默认运行账号'
      choice = { route:baseRoute, name:names[kind], kind, disabled:true, reason }
    }
    if (!choice) continue
    if (index < 0) rows.push(choice)
    else rows[index] = choice
  }
  return [...rows, ...(view?.custom ?? []).map(row => ({ ...row,signedIn:null }))]
}
