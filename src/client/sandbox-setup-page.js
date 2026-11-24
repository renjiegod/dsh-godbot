import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { sandboxProviderKinds } from './provider-agents-model.js'
import { providerAccountsChanged } from './sandbox-settings.js'
import { Switch } from './team-ui/bot-settings.js'
import { FolderMenu } from './team-ui/folder-menu.js'
import { t } from './team-ui/i18n.js'
import style from './provider-agents.css'

const progress = {
  runtime: 'Preparing Lima…',
  vm: 'Starting Ubuntu…',
  keyring: 'Preparing the Antigravity keyring…',
  cli: 'Installing the provider CLI…',
  checking: 'Verifying the sandbox and shared folder…',
  registering: 'Saving the sandbox account…',
}
const hostIssues = {
  unsupported: 'Automatic sandbox creation is available on macOS 14 or later and on x86-64 or ARM64 Linux hosts.',
  'linux-root': 'Run the Godbot host as a regular Linux user to create sandboxes.',
  'linux-tools': 'Install QEMU, its EFI firmware, OpenSSH, curl, and tar on the Linux host.',
  'linux-kvm': 'Give the Linux user running Godbot access to /dev/kvm, then restart the host.',
}

function useSandboxSetup(client) {
  const [view, setView] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [saving, setSaving] = useState(false)
  const [revision, refresh] = useState(0)
  const edit = useRef(false)
  const running = view?.job?.status === 'running'
  useEffect(() => {
    if (saving) return
    let current = true
    let timer
    const read = async () => {
      try {
        const next = await client.dispatch({ action: 'sandbox-setup' })
        if (!current || edit.current) return
        setView(next)
        setLoadError('')
        if (next.job?.status === 'running') timer = setTimeout(read, 1500)
      } catch (error) {
        if (!current || edit.current) return
        setLoadError(error.message)
        if (running) timer = setTimeout(read, 3000)
      }
    }
    void read()
    return () => { current = false; clearTimeout(timer) }
  }, [client, revision, running, saving])

  async function change(action, payload) {
    if (edit.current) return
    edit.current = true
    setSaving(true)
    setActionError('')
    try {
      const result = await client.dispatch({ action, ...payload })
      setView(current => ({ ...current, ...result }))
      if (action === 'sandbox-settings-set') window.dispatchEvent(new Event(providerAccountsChanged))
    } catch (error) {
      setActionError(error.message)
    } finally {
      edit.current = false
      setSaving(false)
    }
  }
  useEffect(() => {
    if (view?.job?.status === 'ready') window.dispatchEvent(new Event(providerAccountsChanged))
  }, [view?.job?.id, view?.job?.status])
  return { view, problem: actionError || loadError, saving, running, change, retry: () => refresh(value => value + 1) }
}

export function SandboxSetupPage({ client, builtins, actions, initialRoute, readOnly, run }) {
  const providers = builtins.filter(agent => Object.hasOwn(sandboxProviderKinds, agent.route))
  const byKind = Object.fromEntries(providers.map(agent => [sandboxProviderKinds[agent.route], agent]))
  const [kind, setKind] = useState(() => sandboxProviderKinds[initialRoute] ?? '')
  const [folder, setFolder] = useState('')
  const { view, problem, saving, running, change, retry } = useSandboxSetup(client)
  const job = view?.job
  const locked = readOnly || saving || running
  const accountRoute = byKind[job?.kind]?.route
  const button = (label, onClick, props = {}) =>
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick, ...props }, t(label))
  const openProvider = route => actions.openSettings('local-agents', route)
  const label = t('Enable sandbox accounts')

  return h('div', { className: 'gb-providers', 'data-godbot-sandbox-setup': true },
    h('style', null, style),
    problem && h('div', { className: 'bt-error', role: 'alert' }, problem,
      !view && button('Refresh', retry)),
    !view && !problem && h('p', { className: 'gb-pr-muted', role: 'status' }, t('Loading sandboxes…')),
    view && h(Fragment, null,
      h('div', { className: 'bt-set-card gb-pr-toggle' }, h('span', { className: 'gb-pr-copy' },
        h('strong', null, label), h('small', null, t('Run each isolated account in its own environment.'))),
      h(Switch, { on: view.enabled, label, disabled: locked,
        onChange: enabled => change('sandbox-settings-set', { enabled }) })),
      view.enabled && h(Fragment, null,
        h('section', { className: 'gb-pr-section', 'aria-label': t('Create a sandbox') },
          h('h3', null, t('Create a sandbox')),
          h('div', { className: 'bt-set-card gb-pr-box' },
            view.available ? h('form', { className: 'gb-sandbox-create', onSubmit: e => {
              e.preventDefault()
              void change('sandbox-create', { kind, folder })
            } },
            h('label', { className: 'gb-pr-copy' }, t('Provider'),
              h('select', { className: 'bt-input', name: 'sandboxProvider', value: kind, disabled: locked, onChange: e => setKind(e.target.value) },
                h('option', { value: '', disabled: true }, t('Choose a sandbox provider')),
                providers.map(provider => {
                  const key = sandboxProviderKinds[provider.route]
                  return h('option', { key, value: key }, provider.name)
                }))),
            h('div', { className: 'gb-pr-copy' }, t('Shared project folder'),
              h(FolderMenu, { value: folder, actions, run, onPick: setFolder, wide: true, disabled: locked,
                fallbackLabel: t('New sandbox workspace') }),
              folder && h('small', null, t('The sandbox can read and write the selected folder.'))),
            h('p', { className: 'gb-pr-muted' }, t('The first setup downloads Lima, Ubuntu, and the selected CLI. This can take several minutes.')),
            h('div', { className: 'gb-pr-actions' }, h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: locked || !kind },
              t('Create automatically')))) :
              h(Fragment, null,
                h('p', { className: 'gb-pr-muted', role: 'status' }, t(hostIssues[view.issue] ?? hostIssues.unsupported)),
                view.issue === 'linux-tools' && h('div', { className: 'gb-pr-actions' },
                  h('a', { href: 'https://lima-vm.io/docs/config/vmtype/qemu/', target: '_blank', rel: 'noreferrer' },
                    t('Linux QEMU setup')),
                  button('Refresh', retry))),
            job?.status === 'running' && h('p', { className: 'gb-pr-hint', role: 'status' },
              byKind[job.kind]?.name, ' · ', t(progress[job.phase])),
            job?.status === 'failed' && h('p', { className: 'bt-error', role: 'alert' }, job.error),
            job?.status === 'ready' && h('div', { className: 'gb-pr-actions', role: 'status' },
              h('span', null, job.error || t('Sandbox ready. Sign in with the provider to use this account.')),
              accountRoute && button('Open provider accounts', () => openProvider(accountRoute))))),
        h('section', { className: 'gb-pr-section', 'aria-label': t('Registered sandboxes') },
          h('h3', null, t('Registered sandboxes')),
          view.accounts.length ? h('ul', { className: 'bt-set-card gb-pr-list' }, view.accounts.map(account =>
            h('li', { key: account.id, className: 'gb-pr-box', 'data-sandbox-id': account.id },
              h('strong', null, account.name),
              h('div', { className: 'gb-pr-actions' }, account.kinds.map(key => byKind[key] &&
                h('button', { key, type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => openProvider(byKind[key].route) }, byKind[key].name))),
              account.workspaces.map(folder => h('p', { key: folder.hostPath, className: 'gb-pr-muted' },
                h('code', null, folder.hostPath), ' · ', t(folder.readOnly ? 'Read-only folder' : 'Read and write')))))) :
            h('p', { className: 'gb-pr-muted' }, t('No sandboxes registered yet.'))))),
    initialRoute && h('div', { className: 'gb-pr-actions' }, button('Back to provider accounts', () => openProvider(initialRoute))))
}
