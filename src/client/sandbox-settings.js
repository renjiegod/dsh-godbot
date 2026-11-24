import { createElement as h, useEffect, useState } from 'react'
import { agentKinds } from './model.js'

export const sandboxKinds = ['antigravity', 'claude', 'codex']
export const providerAccountsChanged = 'godbot:sandbox-settings-changed'

export function useProviderAccounts(client) {
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let revision = 0
    async function refresh() {
      const request = ++revision
      try {
        const next = await client.dispatch({ action: 'provider-accounts' })
        if (request === revision) { setCatalog(next); setError('') }
      } catch (cause) {
        if (request === revision) setError(cause.message)
      }
    }
    void refresh()
    window.addEventListener(providerAccountsChanged, refresh)
    return () => { revision++; window.removeEventListener(providerAccountsChanged, refresh) }
  }, [client])
  return { catalog, error }
}

export function configuredProvider(catalog, kind) {
  return catalog?.providers.find(provider => provider.kind === kind)
}

export function accountWorkspaces(catalog, kind, accountId) {
  return configuredProvider(catalog, kind)?.accounts.find(a => a.id === accountId && a.available)?.workspaces ?? []
}

export function AccountFields({ catalog, kind, accountId, onAccount, cwd, onCwd, disabled, requireChoice = false }) {
  if (!catalog?.enabled && !accountId) return null
  const provider = configuredProvider(catalog, kind)
  if (!provider && !accountId) return null
  const accounts = provider?.accounts.filter(a => (!a.removed && a.available) || a.id === accountId) ?? []
  const selected = accounts.find(a => a.id === accountId)
  const folders = selected?.workspaces ?? []
  function choose(event) {
    const id = event.target.value
    onAccount(id)
    const roots = accounts.find(a => a.id === id)?.workspaces ?? []
    if (id && !roots.some(folder => folder.hostPath === cwd)) onCwd(roots[0]?.hostPath ?? '')
  }
  return h('div', { className: 'gb-sandbox-fields' },
    h('label', { className: 'gb-field' }, h('span', null, '运行账号'),
      h('select', { name: 'accountProfileId', value: requireChoice ? '__choose__' : accountId, onChange: choose, disabled },
        requireChoice && h('option', { value: '__choose__', disabled: true }, '请选择运行账号'),
        !accounts.some(a => a.id === null) && h('option', { value: '' }, '本机默认'),
        accountId && !selected && h('option', { value: accountId }, accountId + '（当前不可用）'),
        accounts.map(a => h('option', { key: a.id ?? 'local', value: a.id ?? '', disabled: !a.available },
          (a.name || (a.local ? '本机默认' : a.slotName)) + (a.removed ? '（已移出）' : a.id === provider.defaultAccountId ? '（首选）' : ''))))),
    accountId && h('label', { className: 'gb-field' }, h('span', null, '宿主共享目录'),
      h('select', { name: 'sandboxCwd', value: cwd, onChange: e => onCwd(e.target.value), disabled: disabled || !selected?.available },
        !folders.some(w => w.hostPath === cwd) && h('option', { value: cwd }, cwd || '请选择目录'),
        folders.map(w => h('option', { key: w.hostPath, value: w.hostPath }, w.hostPath + (w.readOnly ? '（只读）' : '（读写）'))))),
    accountId && !catalog?.enabled && h('p', { role: 'status' }, '请在设置 → 沙箱启用多账号后使用此账号。'))
}

export function SandboxBinding({ client, subject, kind, fullTeam = false, disabled, onSave }) {
  const { catalog, error } = useProviderAccounts(client)
  const current = subject.accountProfileId || ''
  const currentCwd = (fullTeam ? subject.workDir : subject.cwd) || ''
  const [accountId, setAccount] = useState(current)
  const [cwd, setCwd] = useState(currentCwd)
  const [chosenKind, setKind] = useState(kind ?? '')
  const [busy, setBusy] = useState(false)
  const [needsAccount, setNeedsAccount] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => { setAccount(current); setCwd(currentCwd); setKind(kind ?? ''); setNeedsAccount(false); setFailure('') }, [subject.id, current, currentCwd, kind])
  if (!catalog?.enabled && !current) return error ? h('p', { role: 'alert', className: 'gb-error' }, error) : null
  const changed = accountId !== current || Boolean(accountId && cwd !== currentCwd) || Boolean(chosenKind && chosenKind !== kind)
  function selectProvider(event) {
    const nextKind = event.target.value
    const provider = configuredProvider(catalog, nextKind)
    const next = nextKind === kind ? current : provider?.defaultAccountId ?? ''
    setNeedsAccount(nextKind !== kind && provider?.defaultAvailable === false)
    setKind(nextKind)
    setAccount(next)
    setCwd(nextKind === kind ? currentCwd : accountWorkspaces(catalog, nextKind, next)[0]?.hostPath || '')
  }
  async function apply() {
    setBusy(true); setFailure('')
    try {
      await onSave({ accountProfileId: accountId || null, ...(accountId && cwd ? { cwd } : {}),
        ...(fullTeam && chosenKind ? { kind: chosenKind } : {}) })
    } catch (e) { setFailure(e.message) }
    finally { setBusy(false) }
  }
  return h('section', { className: 'gb-sandbox-binding', 'aria-label': '运行环境' },
    h('h3', null, '运行环境'),
    fullTeam && h('label', { className: 'gb-field' }, h('span', null, '提供商'),
      h('select', { value: chosenKind, onChange: selectProvider, disabled: disabled || busy },
        !kind && h('option', { value: '' }, '选择提供商'),
        sandboxKinds.map(k => h('option', { key: k, value: k }, agentKinds[k] || k)))),
    h(AccountFields, { catalog, kind: chosenKind, accountId, requireChoice: needsAccount, onAccount: id => { setAccount(id); setNeedsAccount(false) }, cwd, onCwd: setCwd, disabled: disabled || busy }),
    (error || failure) && h('p', { role: 'alert', className: 'gb-error' }, error || failure),
    changed && h('button', { type: 'button', className: 'bt-soft gb-setting-save', onClick: apply, disabled: disabled || busy || needsAccount || (!!accountId && (!catalog?.enabled || !cwd)) },
      busy ? '正在切换…' : subject.nativeId || fullTeam ? '切换运行环境并开始新会话' : '应用运行环境'))
}
