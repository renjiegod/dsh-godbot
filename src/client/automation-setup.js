import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { AutomationEditor, filterLabels, formatDate, targetLabels, triggerText } from './automation-editor.js'
import automationStyle from './automation.css'
import { pendingRequests } from './model.js'
import { ChevronRightIcon, ClockIcon, PlusIcon } from './team-ui/icons.js'
import { t } from './team-ui/i18n.js'

const statuses = { scheduled: 'Active', active: 'Active', overdue: 'Overdue', paused: 'Paused', finished: 'Finished' }
const runStatuses = {
  delivered: 'Delivered', running: 'Running', completed: 'Accepted', needs_input: 'Needs input',
  failed: 'Failed', unknown: 'Unverified', skipped: 'Skipped', stopped: 'Team stopped',
}
const notices = { create: 'Automation created', update: 'Changes saved', run: 'Run requested',
  poll: 'Events checked', pause: 'Automation paused', resume: 'Automation resumed', delete: 'Automation deleted' }
const action = (label, onClick, props = {}) => h('button', {
  type: 'button', className: 'bt-soft bt-soft-sm', onClick, ...props,
}, t(label))
const itemKey = item => item.source + '/' + item.id
const identity = ({ source, id, sessionId, updatedAt, revision }) => ({ source, id, sessionId, updatedAt, revision })
const isScheduled = item => item.trigger.kind === 'schedule'

function RunHistory({ client, item, actions }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const paging = useRef(false)
  const read = useCallback(async before => {
    paging.current = Boolean(before)
    const token = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const result = await client.dispatch({ action: 'automation.setup.history', source: item.source, id: item.id, sessionId: item.sessionId, before })
      if (sequence.current === token) setData(old => before ? { ...result, items: [...old.items, ...result.items] } : result)
    } catch (cause) {
      if (sequence.current === token) setError(cause.message)
    } finally {
      if (sequence.current === token) setLoading(false)
    }
  }, [client, item.source, item.id, item.sessionId])
  useEffect(() => {
    void read()
    const timer = setInterval(() => { if (!paging.current && !document.hidden) void read() }, 5000)
    return () => { sequence.current++; clearInterval(timer) }
  }, [read])
  const showTask = id => actions.openWorkBoard({ taskId:id })
  const openChat = id => { actions.closeSettings(); actions.openSession(id) }
  return h('section', { className: 'gb-auto-history', 'aria-label': t('Run history') },
    h('div', { className: 'gb-auto-toolbar' }, h('h4', null, t('Run history')), action('Refresh', () => read(), { disabled: loading })),
    !data && loading && h('p', { role: 'status' }, t('Loading…')),
    error && h('p', { role: 'alert', className: 'gb-auto-error' }, error),
    data?.items.length === 0 && h('p', { className: 'bt-set-hint' }, t('No runs yet.')),
    data?.items.length > 0 && h('ol', null, data.items.map(record => h('li', { key: record.id },
      h('div', { className: 'gb-auto-actions' },
        h('time', null, formatDate(record.at)),
        record.trigger && h('span', null, t(record.trigger === 'manual' ? 'Manual run' : 'Scheduled run')),
        h('strong', null, t(runStatuses[record.state] ?? record.state)),
        record.workflowRevision && h('span', null, 'v' + record.workflowRevision),
        record.sessionId ? action('Open conversation', () => openChat(record.sessionId))
          : record.workflowId && record.runId ? action('Open workflow run', () => actions.openSettings('tasks', { workflowId: record.workflowId, workflowRunId: record.runId }))
          : record.rootTaskId ? action('Open task', () => showTask(record.rootTaskId)) : null),
      record.nodes?.length > 0 && h('details', null, h('summary', null, t('Workflow tasks')),
        record.nodes.map(node => h('div', { className: 'gb-auto-actions', key: node.nodeId },
          h('span', null, node.title + ' · ' + node.status), action('Open task', () => showTask(node.taskId), { 'aria-label': t('Open task') + ' ' + node.title })))),
      record.prompt && h('p', { className: 'gb-auto-text' }, record.prompt),
      record.reason && h('p', { className: 'bt-set-hint' }, record.reason)))),
    data?.nextBefore && action('Older runs', () => read(data.nextBefore), { disabled: loading }),
    data && !data.nextBefore && data.earlierRecordsUnavailable &&
      h('p', { className: 'bt-set-hint' }, t(data.earlierRecordsPruned ? 'Older runs expired.' : 'The host has no older delivery records.')))
}

function AutomationRow({ item, name, client, actions, expanded, onToggle, onEdit, onChange, busy, readOnly, latestRun }) {
  const [history, setHistory] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const paused = item.status === 'paused'
  const scheduled = isScheduled(item)
  const cooling = Date.parse(item.deliveryFloorEndsAt) > Date.now()
  const trigger = triggerText(item.trigger)
  return h('article', { 'aria-label': item.title },
    h('button', { type: 'button', className: 'gb-auto-row', onClick: onToggle, 'aria-expanded': expanded },
      h('span', { className: 'gb-auto-icon', 'aria-hidden': true }, h(ClockIcon)),
      h('span', { className: 'gb-auto-row-main' },
        h('strong', null, item.title),
        h('span', { className: 'bt-set-hint' }, [t(targetLabels[item.target.kind]), name, trigger].filter(Boolean).join(' · '))),
      h('span', { className: 'gb-auto-state', 'data-state': item.status }, t(statuses[item.status] ?? 'Finished')),
      item.nextAt != null ? h('time', { className: 'gb-auto-next', title: t('Next run') }, t('Next: {time}', { time: formatDate(item.nextAt) })) : null,
      h('span', { className: 'gb-auto-chevron', 'aria-hidden': true }, h(ChevronRightIcon))),
    expanded && h('div', { className: 'gb-auto-detail' },
      item.instructions && h('p', { className: 'gb-auto-text' }, item.instructions),
      item.trigger.url && h('code', { className: 'gb-auto-text' }, item.trigger.url),
      item.checkOnly && h('p', { className: 'bt-set-hint' }, t('Check and report only')),
      item.issue && h('p', { className: 'gb-auto-error', role: 'status' }, item.issue),
      item.lastChecked && h('p', { className: 'bt-set-hint' }, t('Last checked {time}', { time: formatDate(item.lastChecked) })),
      item.lastRunId && h('p', { className: 'bt-set-hint' }, t('Latest run') + ' · ', h('code', null, item.lastRunId)),
      item.executionActive && h('p', { className: 'bt-set-hint' }, t('A delivery is queued or running.')),
      !item.executionActive && cooling && h('p', { className: 'bt-set-hint' }, t('Available again {time}', { time: formatDate(item.deliveryFloorEndsAt) })),
      h('div', { className: 'gb-auto-actions' },
        scheduled && !readOnly && action('Edit', onEdit, { disabled: busy }),
        scheduled && !readOnly && action('Run now', () => {
          setHistory(true)
          onChange('run')
        }, { disabled: busy || item.executionActive || cooling }),
        item.source === 'github' && !readOnly && action('Check events', () => onChange('poll'), { disabled: busy || paused }),
        !readOnly && item.status !== 'finished' && action(paused ? 'Resume automation' : 'Pause', () => onChange(paused ? 'resume' : 'pause'), { disabled: busy }),
        scheduled && action('Run history', () => setHistory(open => !open), { 'aria-expanded': history }),
        scheduled && !readOnly && action('Delete', () => setConfirm(true), { disabled: busy || confirm, className: 'bt-soft bt-soft-sm bt-danger' })),
      confirm && !readOnly && h('div', { className: 'gb-auto-actions' },
        h('span', null, t(item.source === 'message' ? 'Delete this automation and its delivery history?' : 'Delete this automation? Assigned tasks stay on the task board.')),
        action('Cancel', () => setConfirm(false), { disabled: busy }),
        action('Confirm deletion', () => onChange('delete'), { disabled: busy, className: 'bt-soft bt-soft-sm bt-danger' })),
      scheduled && history && h(RunHistory, { key: latestRun, client, item, actions })))
}

export function AutomationSetupPage({ client, roster, actions, initial }) {
  const [view, setView] = useState(null)
  const [filter, setFilter] = useState('all')
  const [targetFilter, setTargetFilter] = useState(initial?.scope ?? '')
  const [editor, setEditor] = useState(initial?.kind ? {} : null)
  const [expanded, setExpanded] = useState(null)
  const [runVersion, setRunVersion] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [issued, setIssued] = useState(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const [ledger] = useState(() => {
    try { return pendingRequests(window.sessionStorage) } catch { return pendingRequests() }
  })
  const reload = useCallback(async () => {
    const token = ++sequence.current
    try {
      const next = await client.dispatch({ action: 'automation.setup.view' })
      if (mounted.current && token === sequence.current) {
        setView(next)
        setLoadError('')
      }
    } catch (cause) {
      if (mounted.current && token === sequence.current) setLoadError(cause.message)
    }
  }, [client])
  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer
    async function poll() {
      if (!inFlight.current && !document.hidden) await reload()
      if (!stopped) timer = setTimeout(poll, 7000)
    }
    void reload()
    timer = setTimeout(poll, 7000)
    const visible = () => { if (!inFlight.current && !document.hidden) void reload() }
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      mounted.current = false
      sequence.current++
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [reload])

  const { bots, rooms, readOnly } = roster
  const targets = [...bots, ...rooms]
  const labels = new Map(targets.map(target => [target.id, target.name]))
  const rows = view?.items.filter(item => (filter === 'all' || filter === item.target.kind) && (!targetFilter || item.target.id === targetFilter))
    .sort((a, b) => (a.nextAt == null ? Infinity : new Date(a.nextAt).getTime()) -
      (b.nextAt == null ? Infinity : new Date(b.nextAt).getTime()) || a.title.localeCompare(b.title))
  const openPlugins = () => actions.openSettings('dsh', 'plugins')

  async function mutate(operation, item, fields = {}) {
    if (inFlight.current || readOnly) return
    inFlight.current = true
    sequence.current++
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const request = operation === 'create' ? { action: 'automation.setup.create', ...fields }
        : { action: 'automation.setup.change', operation, ...identity(item), ...fields }
      const ticket = await ledger.begin(request)
      const result = await client.dispatch({ ...request, requestId: ticket.id })
      ledger.complete(ticket)
      if (!mounted.current) return
      if (operation === 'create') {
        setFilter('all')
        if (targetFilter && targetFilter !== fields.target.id) setTargetFilter('')
        setExpanded((result.mode === 'messages' ? 'message' : result.mode === 'routines' ? 'routine' : fields.trigger.kind) + '/' + result.id)
        if (result.secret) setIssued(result)
      } else if (operation === 'update' && fields.target) {
        if (filter !== 'all' && fields.target.kind !== filter) setFilter(fields.target.kind)
        if (targetFilter && targetFilter !== fields.target.id) setTargetFilter(fields.target.id)
      }
      if (operation === 'run') setRunVersion(version => version + 1)
      if (operation === 'create' || operation === 'update') setEditor(null)
      setNotice(t(notices[operation]))
    } catch (cause) {
      if (mounted.current) setError(cause.message)
    } finally {
      if (mounted.current) await reload()
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function showEditor(value) {
    setError('')
    setNotice('')
    setEditor(value)
  }

  return h('section', { className: 'gb-automation', 'aria-label': t('Automation') },
    h('style', null, automationStyle),
    loadError && h('div', { className: 'gb-auto-actions', role: 'alert' }, h('span', { className: 'gb-auto-error' }, loadError), action('Retry', reload)),
    error && h('p', { role: 'alert', className: 'gb-auto-error' }, error),
    notice && h('p', { role: 'status', className: 'bt-set-hint' }, notice),
    issued && h('section', { className: 'gb-auto-issued bt-set-card', 'aria-label': 'Webhook' },
      h('strong', null, t('Save the Webhook signing secret now.')),
      h('code', { className: 'gb-auto-text' }, issued.url),
      h('code', { className: 'gb-auto-text', 'data-sensitive': true }, issued.secret),
      action('Done', () => setIssued(null))),
    !view ? (!loadError && h('p', { role: 'status' }, t('Loading…')))
      : editor && !readOnly ? h(AutomationEditor, { key: editor.item ? itemKey(editor.item) : 'new', item: editor.item,
        initial: { kind: initial?.kind ?? (filter === 'all' ? undefined : filter), id: initial?.id ?? targetFilter },
        view, bots, rooms, busy, onSave: fields => mutate(editor.item ? 'update' : 'create', editor.item, fields), onCancel: () => showEditor(null),
        openPlugins, openWorkflows: () => actions.openSettings('tasks') })
      : h('div', { className: 'gb-auto-list-view' },
        h('div', { className: 'gb-auto-toolbar' },
          h('div', { className: 'gb-auto-filters', role: 'group', 'aria-label': t('Filter automations') },
            Object.entries(filterLabels).map(([key, label]) => h('button', {
              key, type: 'button', 'aria-pressed': filter === key, onClick: () => setFilter(key),
            }, t(label)))),
          !readOnly && h('button', { type: 'button', className: 'bt-send bt-soft-sm gb-auto-new', onClick: () => showEditor({}) },
            h(PlusIcon), t('New automation'))),
        targetFilter && h('div', { className: 'gb-auto-actions' }, h('span', { className: 'bt-set-hint' }, labels.get(targetFilter) ?? targetFilter),
          action('Clear target filter', () => setTargetFilter(''))),
        !view.available && (filter === 'all' || filter === 'message') && h('div', { className: 'gb-auto-actions' },
          h('span', { className: 'bt-set-hint' }, t('Switch on Automation tasks on the Plugins page in Settings.')), action('Open Plugins', openPlugins)),
        rows.length ? h('div', { className: 'bt-set-card gb-auto-list' }, rows.map(item => {
          const key = itemKey(item)
          const target = item.target
          const name = target.kind === 'workflow' ? (target.name ?? view.workflows.find(flow => flow.id === target.id)?.name ?? target.id) + ' · v' + target.revision
            : labels.get(target.id) ?? target.id
          return h(AutomationRow, { key, item, name, client, actions, busy, readOnly, expanded: expanded === key,
            latestRun: expanded === key ? runVersion : 0,
            onToggle: () => setExpanded(expanded === key ? null : key), onEdit: () => showEditor({ item }),
            onChange: op => mutate(op, item) })
        })) : h('div', { className: 'bt-set-card gb-auto-empty' }, h(ClockIcon), h('p', null, t(filter === 'all' && !targetFilter ? 'No automations yet.' : 'No matching automations.')))))
}
