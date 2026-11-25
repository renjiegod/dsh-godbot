import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { GodbotModal } from './modal.js'
import { sandboxProviderKinds } from './provider-agents-model.js'
import { providerAccountsChanged } from './sandbox-settings.js'
import { Switch } from './team-ui/bot-settings.js'
import { FolderMenu } from './team-ui/folder-menu.js'
import { ChevronLeftIcon } from './team-ui/icons.js'
import { t } from './team-ui/i18n.js'
import style from './provider-agents.css'

const phases = {
  runtime: 'Preparing Lima…',
  vm: 'Starting Ubuntu…',
  keyring: 'Preparing the Antigravity keyring…',
  cli: 'Installing the provider CLI…',
  checking: 'Verifying the sandbox and shared folder…',
  registering: 'Saving the sandbox account…',
}
const states = {
  pending: 'Provisioning sandbox',
  starting: 'Starting sandbox',
  running: 'Sandbox running',
  stopping: 'Stopping sandbox',
  stopped: 'Sandbox stopped',
  deleting: 'Deleting sandbox',
  failed: 'Sandbox operation failed',
  missing: 'Sandbox VM missing',
  unknown: 'Sandbox state unavailable',
  external: 'Externally managed',
}
const operations = { start: 'Start sandbox', stop: 'Stop sandbox', retry: 'Retry creation', delete: 'Delete sandbox' }
const changing = new Set(['pending', 'starting', 'stopping', 'deleting'])
const hostIssues = {
  unsupported: 'Automatic sandbox creation is available on macOS 14 or later and on x86-64 or ARM64 Linux hosts.',
  'linux-root': 'Run the Godbot host as a regular Linux user to create sandboxes.',
  'linux-tools': 'Install QEMU, its EFI firmware, OpenSSH, curl, and tar on the Linux host.',
  'linux-kvm': 'Give the Linux user running Godbot access to /dev/kvm, then restart the host.',
}

function useSandboxView(client) {
  const [view, setView] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [saving, setSaving] = useState(false)
  const [revision, refresh] = useState(0)
  const submitting = useRef(false)

  useEffect(() => {
    if (saving) return
    let alive = true
    let reading = false
    let timer
    const read = async () => {
      clearTimeout(timer)
      if (!alive || reading || submitting.current || document.hidden) return
      reading = true
      let delay = 5000
      try {
        const next = await client.dispatch({ action: 'sandbox-setup' })
        if (!alive || submitting.current) return
        setView(next)
        setLoadError('')
        if (next.sandboxes.some(row => changing.has(row.status.state))) delay = 1200
      } catch (error) {
        if (alive && !submitting.current) setLoadError(error.message)
      } finally {
        reading = false
        if (alive && !document.hidden) timer = setTimeout(read, delay)
      }
    }
    document.addEventListener('visibilitychange', read)
    void read()
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', read) }
  }, [client, revision, saving])

  const registered = view?.accounts.map(account => account.id).join(',')
  useEffect(() => {
    if (registered !== undefined) window.dispatchEvent(new Event(providerAccountsChanged))
  }, [registered])

  async function change(action, payload) {
    if (submitting.current) return
    submitting.current = true
    setSaving(true)
    setActionError('')
    try {
      const result = await client.dispatch({ action, ...payload })
      if (action === 'sandbox-settings-set') setView(current => ({ ...current, ...result }))
      return result
    } catch (error) {
      setActionError(error.message)
    } finally {
      submitting.current = false
      setSaving(false)
      refresh(value => value + 1)
    }
  }

  return { view, saving, problem: actionError || loadError, change, refresh: () => refresh(value => value + 1),
    clearError: () => setActionError('') }
}

const button = (label, onClick, props = {}) =>
  h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick, ...props }, t(label))
const back = navigate => h('button', { type: 'button', className: 'gb-pr-back', onClick: navigate },
  h(ChevronLeftIcon), t('Back to sandboxes'))
const statusLabel = status => t(states[status.state] ?? states.unknown)
const badge = status => h('span', { className: 'gb-sandbox-status', 'data-state': status.state }, statusLabel(status))
const providerNames = (row, byKind) => row.kinds.map(kind => byKind[kind]?.name ?? kind).join(' · ')

function SandboxCatalog({ rows, byKind, inspect }) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState('')
  const term = query.trim().toLowerCase()
  const sandboxes = rows.filter(row => (!state || row.status.state === state) &&
    (!term || [row.name, row.id, providerNames(row, byKind), ...row.workspaces.map(folder => folder.hostPath)]
      .some(value => value.toLowerCase().includes(term))))
  return h('section', { className: 'gb-pr-section', 'aria-label': t('Sandbox instances') },
    rows.length ? h('div', { className: 'gb-pr-toolbar' },
      h('input', { type: 'search', className: 'bt-input', placeholder: t('Search sandboxes'), 'aria-label': t('Search sandboxes'),
        value: query, onChange: event => setQuery(event.target.value) }),
      h('select', { className: 'bt-input', value: state, 'aria-label': t('Filter by state'), onChange: event => setState(event.target.value) },
        h('option', { value: '' }, t('All sandbox states')),
        Object.entries(states).map(([value, name]) => h('option', { key: value, value }, t(name))))) : null,
    sandboxes.length ? h('ul', { className: 'bt-set-card gb-pr-list' }, sandboxes.map(row =>
      h('li', { key: row.id, 'data-sandbox-id': row.id },
        h('button', { type: 'button', className: 'gb-pr-row gb-sandbox-row', onClick: () => inspect(row.id) },
          h('span', { className: 'gb-pr-copy' },
            h('strong', null, row.name), h('small', null, providerNames(row, byKind)),
            row.workspaces[0] ? h('small', { className: 'gb-pr-subtitle', title: row.workspaces[0].hostPath }, row.workspaces[0].hostPath) : null),
          badge(row.status))))) : h('p', { className: 'bt-set-card gb-pr-box gb-pr-muted' },
      t(rows.length ? 'No matching sandboxes.' : 'No sandboxes registered yet.')))
}

function CreateSandbox({ initialKind, byKind, actions, run, locked, create }) {
  const [kind, setKind] = useState(initialKind || '')
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const request = useRef()
  const submit = event => {
    event.preventDefault()
    const key = JSON.stringify([kind, folder, name])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    void create({ kind, folder, name, requestId: request.current.id })
  }
  return h('form', { className: 'bt-set-card gb-pr-box gb-sandbox-create', onSubmit: submit },
    h('h3', null, t('Create a sandbox')),
    h('label', { className: 'gb-pr-copy' }, t('Sandbox name'),
      h('input', { className: 'bt-input', value: name, maxLength: 100, placeholder: t('Optional sandbox name'),
        disabled: locked, onChange: event => setName(event.target.value) })),
    h('label', { className: 'gb-pr-copy' }, t('Provider'),
      h('select', { className: 'bt-input', name: 'sandboxProvider', value: kind, disabled: locked, onChange: event => setKind(event.target.value) },
        h('option', { value: '', disabled: true }, t('Choose a sandbox provider')),
        Object.entries(byKind).map(([key, provider]) => h('option', { key, value: key }, provider.name)))),
    h('div', { className: 'gb-pr-copy' }, t('Shared project folder'),
      h(FolderMenu, { value: folder, actions, run, onPick: setFolder, wide: true, disabled: locked,
        fallbackLabel: t('New sandbox workspace') }),
      folder ? h('small', null, t('The sandbox can read and write the selected folder.')) : null),
    h('p', { className: 'gb-pr-muted' }, t('The first setup downloads Lima, Ubuntu, and the selected CLI. This can take several minutes.')),
    h('div', { className: 'gb-pr-actions' }, h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: locked || !kind },
      t('Create automatically'))))
}

function SandboxDetails({ row, byKind, enabled, locked, openProvider, manage }) {
  const { status } = row
  const message = status.message || (status.reason === 'interrupted' ? t('The host stopped during this operation.') :
    changing.has(status.state) && status.phase ? t(phases[status.phase] ?? states[status.state]) : null)
  const fields = [
    ['Sandbox ID', row.id],
    ['Provider', providerNames(row, byKind)],
    ...(row.createdAt ? [['Sandbox created at', new Date(row.createdAt).toLocaleString()]] : []),
    ...(status.updatedAt ? [['Last sandbox operation', new Date(status.updatedAt).toLocaleString()]] : []),
    ...(row.bindings ? [['Bound Bots', String(row.bindings)]] : []),
  ]
  return h('section', { className: 'bt-set-card gb-pr-box', 'data-sandbox-id': row.id },
    h('div', { className: 'gb-pr-heading' }, h('h3', null, row.name), badge(status)),
    message ? h('p', { className: status.state === 'failed' ? 'bt-danger' : 'gb-pr-muted',
      role: status.state === 'failed' ? 'alert' : 'status' }, message) : null,
    h('dl', { className: 'gb-sandbox-fields' }, fields.map(([label, value]) =>
      h(Fragment, { key: label }, h('dt', null, t(label)), h('dd', null, value)))),
    row.workspaces.map(folder => h('div', { key: folder.hostPath, className: 'gb-pr-copy' },
      h('small', null, t('Shared project folder'), ' · ', t(folder.readOnly ? 'Read-only folder' : 'Read and write')),
      h('code', { className: 'gb-pr-path' }, folder.hostPath))),
    row.active ? h('p', { className: 'gb-pr-muted' }, t('This sandbox is in use.')) : null,
    row.stoppedByUser ? h('p', { className: 'gb-pr-muted' }, t('Start this sandbox to use its accounts again.')) : null,
    row.attachmentPending ? h('p', { className: 'gb-pr-muted' }, t('Add this sandbox in the provider account list.')) : null,
    !row.managed ? h('p', { className: 'gb-pr-muted' }, t('Use the original runtime to manage this registered sandbox.')) : null,
    h('div', { className: 'gb-pr-actions' },
      row.actions.map(action => button(operations[action], () => manage(action), {
        key: action, disabled: locked, ...(action === 'delete' ? { className: 'bt-soft bt-soft-sm bt-danger' } : {}),
      })),
      enabled && row.registered ? row.kinds.map(kind => byKind[kind] &&
        button(row.kinds.length === 1 ? 'Open provider accounts' : byKind[kind].name, () => openProvider(byKind[kind].route),
          { key: kind })) : null))
}

export function SandboxSetupPage({ client, builtins, actions, initialRoute, readOnly, run }) {
  const byKind = Object.fromEntries(builtins.filter(agent => Object.hasOwn(sandboxProviderKinds, agent.route))
    .map(agent => [sandboxProviderKinds[agent.route], agent]))
  const initialKind = sandboxProviderKinds[initialRoute]
  const [panel, setPanel] = useState(initialKind && !readOnly ? 'create' : 'list')
  const [selected, select] = useState('')
  const [confirm, setConfirm] = useState(false)
  const { view, saving, problem, change, refresh, clearError } = useSandboxView(client)
  const row = view?.sandboxes.find(item => item.id === selected)
  const locked = readOnly || saving
  const open = (next, id = '') => { clearError(); setPanel(next); select(id) }
  const openProvider = route => actions.openSettings('local-agents', route)
  const label = t('Enable sandbox accounts')
  const create = async payload => {
    const result = await change('sandbox-create', payload)
    if (result) open('detail', result.id)
  }
  const manage = async operation => {
    if (operation === 'delete' && !confirm) { setConfirm(true); return }
    const result = await change('sandbox-manage', { id: selected, operation, confirmed: confirm })
    if (operation === 'delete' && result) { setConfirm(false); open('list') }
  }

  return h('div', { className: 'gb-providers', 'data-godbot-sandbox-setup': true },
    h('style', null, style),
    problem ? h('div', { className: 'bt-error', role: 'alert' }, problem) : null,
    !view ? h(Fragment, null, h('p', { className: 'gb-pr-muted', role: 'status' }, t('Loading sandboxes…')),
      problem ? button('Refresh', refresh) : null) : h(Fragment, null,
      h('div', { className: 'bt-set-card gb-pr-toggle' }, h('span', { className: 'gb-pr-copy' },
        h('strong', null, label), h('small', null, t('Run each isolated account in its own environment.'))),
      h(Switch, { on: view.enabled, label, disabled: locked || view.creating,
        onChange: enabled => change('sandbox-settings-set', { enabled }) })),
      view.registryIssue ? h('p', { className: 'bt-error', role: 'alert' }, t('Check the sandbox account registry on the host.')) : null,
      view.issue && view.enabled ? h('div', { className: 'bt-set-card gb-pr-box gb-pr-muted' },
        h('p', null, t(hostIssues[view.issue] ?? hostIssues.unsupported)),
        view.issue === 'linux-tools' ? h('a', { href: 'https://lima-vm.io/docs/config/vmtype/qemu/', target: '_blank', rel: 'noreferrer' },
          t('Linux QEMU setup')) : null, button('Refresh', refresh)) : null,
      panel === 'create' && view.enabled && view.available ? h(Fragment, null, back(() => open('list')),
        h(CreateSandbox, { initialKind, byKind, actions, run, locked: locked || view.creating || view.registryIssue, create })) :
        panel === 'detail' ? h(Fragment, null, back(() => open('list')),
          row ? h(SandboxDetails, { row, byKind, enabled: view.enabled, locked, openProvider, manage }) :
            h('p', { className: 'gb-pr-muted', role: 'status' }, t('Loading sandboxes…'))) :
          h(Fragment, null,
            h('div', { className: 'gb-pr-heading' }, h('h3', null, t('Sandbox instances')),
              h('div', { className: 'gb-pr-actions' }, button('Refresh', refresh, { disabled: saving }),
                view.enabled && view.available && !readOnly ? button('Create a sandbox', () => open('create'),
                  { className: 'bt-send bt-soft-sm', disabled: view.creating || view.registryIssue || saving }) : null)),
            h(SandboxCatalog, { rows: view.sandboxes, byKind, inspect: id => open('detail', id) }))),
    initialRoute ? h('div', { className: 'gb-pr-actions' }, button('Back to provider accounts', () => openProvider(initialRoute))) : null,
    confirm && row ? h(GodbotModal, { title: t('Delete sandbox'), closeLabel: t('Close'), close: () => setConfirm(false) },
      h('div', { className: 'gb-pr-box' },
        h('p', null, row.name),
        h('p', null, t('Deleting removes the virtual machine and its sign-in data. Shared project files are kept.')),
        problem ? h('p', { role: 'alert', className: 'bt-danger' }, problem) : null,
        h('div', { className: 'gb-pr-actions' }, button('Cancel', () => setConfirm(false)),
          button('Delete sandbox', () => void manage('delete'), { disabled: locked, className: 'bt-soft bt-soft-sm bt-danger' })))) : null)
}
