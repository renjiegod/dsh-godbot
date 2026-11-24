import { createElement as h, Fragment, useState } from 'react'
import { t } from './i18n.js'

const reasons = {
  timeout: 'Timeout',
  network: 'API and network errors',
  authentication: 'Sign-in or credential errors',
  quota: 'Rate limit or quota',
  agent: 'Agent unavailable',
}
const statuses = {
  switched: 'Switched Agent',
  queued: 'Handoff queued',
  running: 'Backup Bot working',
  completed: 'Handoff completed',
  failed: 'Handoff failed',
  exhausted: 'No backup Bot available',
  stopped: 'Handoff stopped',
}
const defaults = () => ({ triggers: Object.keys(reasons), agents: [], bots: [], timeoutSeconds: null })

export function failoverLabel(row, roster) {
  const target = row.kind === 'agent' ? row.target : roster.byId[row.targetBotId]?.name
  return [t(statuses[row.status] ?? row.status), target].filter(Boolean).join(' · ')
}

export function FailoverActivity({ row, roster, actions }) {
  const label = failoverLabel(row, roster)
  return row.targetBotId && row.targetSessionId && !row.roomId && roster.byId[row.targetBotId]
    ? h('button', { className: 'bt-soft bt-soft-sm gb-failover-activity', type: 'button', title: label,
      onClick: () => void Promise.resolve(actions.openPart(row.targetBotId, row.targetSessionId)).catch(error => actions.reportError(error, 'failover')) }, label)
    : h('span', { className: 'gb-failover-activity', title: label }, label)
}

function RouteList({ label, values, options, onChange, disabled }) {
  const choices = options.filter(option => !values.includes(option.id))
  const select = (index, step) => {
    const next = [...values]
    const other = index + step
    ;[next[index], next[other]] = [next[other], next[index]]
    onChange(next)
  }
  return h('fieldset', { className: 'gb-failover-routes', disabled },
    h('legend', null, label),
    values.length ? h('ol', null, values.map((id, index) => {
      const name = options.find(option => option.id === id)?.name ?? id
      return h('li', { key: id },
        h('span', { title: name }, name),
        h('button', { className: 'bt-soft bt-soft-sm', type: 'button', disabled: index === 0,
          'aria-label': t('Move up'), onClick: () => select(index, -1) }, '↑'),
        h('button', { className: 'bt-soft bt-soft-sm', type: 'button', disabled: index === values.length - 1,
          'aria-label': t('Move down'), onClick: () => select(index, 1) }, '↓'),
        h('button', { className: 'bt-soft bt-soft-sm', type: 'button', 'aria-label': t('Remove {name}', { name }),
          onClick: () => onChange(values.filter(value => value !== id)) }, '×'))
    })) : null,
    values.length < 5 ? h('select', { className: 'bt-input', value: '', disabled: !choices.length, 'aria-label': label,
      onChange: event => { if (event.target.value) onChange([...values, event.target.value]) } },
    h('option', { value: '' }, t('Add')),
    choices.map(option => h('option', { key: option.id, value: option.id }, option.name))) : null)
}

function FailoverEditor({ bot, roster, actions, close }) {
  const [draft, setDraft] = useState(() => bot.failover ? { ...bot.failover, bots: bot.private ? [] : bot.failover.bots } : defaults())
  const [timeout, setTimeoutText] = useState(() => String(bot.failover?.timeoutSeconds ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const primary = bot.model ?? bot.appliedModel
  const agents = (roster.models ?? []).filter(model => model.ref && model.ref !== primary &&
    !model.ref.startsWith('local-sandbox-') && !model.ref.startsWith('ag-ui-'))
    .map(model => ({ id: model.ref, name: [model.providerName ?? model.provider, model.name ?? model.id].filter(Boolean).join(' · ') }))
  const bots = (roster.bots ?? []).filter(option => option.id !== bot.id && !option.private && !option.accountProfileId &&
    !(option.model ?? option.appliedModel)?.startsWith('ag-ui-'))
    .map(option => ({ id: option.id, name: option.name }))
  const by = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const hasTimeout = draft.triggers.includes('timeout')
  const seconds = hasTimeout && timeout !== '' ? Number(timeout) : null
  const valid = draft.triggers.length > 0 && draft.agents.length + draft.bots.length > 0 &&
    (seconds === null || (Number.isInteger(seconds) && seconds >= 1 && seconds <= 600))
  const save = async (policy) => {
    setBusy(true)
    setError('')
    try {
      await actions.updateBot(bot.id, policy === null ? { failover: null } : { failover: { ...draft, timeoutSeconds: seconds } })
      close()
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    } finally { setBusy(false) }
  }
  return h('div', { className: 'gb-failover-form', 'data-godbot-failover-form': '' },
    h('fieldset', { disabled: busy },
      h('legend', null, t('Failover triggers')),
      Object.entries(reasons).map(([id, label]) => h('label', { key: id },
        h('input', { type: 'checkbox', checked: draft.triggers.includes(id), onChange: event =>
          by('triggers', event.target.checked ? [...draft.triggers, id] : draft.triggers.filter(value => value !== id)) }), t(label)))),
    hasTimeout ? h('label', { className: 'gb-failover-timeout' }, t('Agent deadline in seconds'),
      h('input', { className: 'bt-input', type: 'number', min: 1, max: 600, value: timeout, disabled: busy, placeholder: t('Provider default'),
        onChange: event => setTimeoutText(event.target.value) })) : null,
    h(RouteList, { label: t('Backup Agents in order'), values: draft.agents, options: agents,
      onChange: value => by('agents', value), disabled: busy }),
    bot.private ? null : h(RouteList, { label: t('Backup Bots in order'), values: draft.bots, options: bots,
      onChange: value => by('bots', value), disabled: busy }),
    h('p', { className: 'bt-set-hint' }, t('Agents keep the current conversation. A backup Bot receives the task in its own conversation, or in the same group chat. Handoffs require matching permissions and a turn with no tools or reply yet.')),
    error ? h('p', { className: 'gb-failover-error', role: 'alert' }, error) : null,
    h('div', { className: 'gb-failover-actions' },
      bot.failover ? h('button', { className: 'bt-soft bt-soft-sm', type: 'button', disabled: busy, onClick: () => void save(null) }, t('Disable failover')) : null,
      h('button', { className: 'bt-soft bt-soft-sm', type: 'button', disabled: busy, onClick: close }, t('Cancel')),
      h('button', { className: 'bt-soft bt-soft-sm', type: 'button', disabled: busy || !valid, onClick: () => void save(draft) }, t('Save'))))
}

export function BotFailoverSettings({ bot, roster, actions, Card, Row }) {
  const [editing, setEditing] = useState(false)
  const locked = Boolean(bot.accountProfileId || (bot.model ?? bot.appliedModel)?.startsWith('ag-ui-'))
  return h(Card, { title: t('Failover') },
    h(Row, { label: t(bot.failover ? 'Enabled' : 'Disabled'), hint: locked ? t('This Bot uses a dedicated Agent binding.') : undefined },
      !roster.readOnly && !locked && !editing ? h('button', {
        className: 'bt-soft bt-soft-sm', type: 'button', 'aria-label': t('Configure failover'), onClick: () => setEditing(true),
      }, t('Configure failover')) : null),
    editing && !locked ? h(FailoverEditor, { key: bot.id, bot, roster, actions, close: () => setEditing(false) }) : null,
    bot.failoverHistory?.length ? h('div', { className: 'gb-failover-form' },
      h('strong', null, t('Recent failover activity')),
      bot.failoverHistory.map(row => h(Fragment, { key: row.id },
        h(FailoverActivity, { row, roster, actions })))) : null)
}

export const FAILOVER_CSS = `
.gb-failover-form{display:grid;gap:10px;padding:10px 14px}
.gb-failover-form fieldset{display:grid;gap:6px;min-width:0;margin:0;border:1px solid var(--bt-line-2);border-radius:8px;padding:8px}
.gb-failover-form legend{padding:0 4px;color:var(--bt-ink-2);font-weight:600}
.gb-failover-form label{display:flex;align-items:center;gap:6px}
.gb-failover-form input[type=checkbox]{accent-color:var(--bt-accent)}
.gb-failover-timeout{flex-wrap:wrap;justify-content:space-between}
.gb-failover-timeout input{width:112px}
.gb-failover-routes ol{padding-left:20px;margin:0}
.gb-failover-routes li{padding:2px 0}
.gb-failover-routes li span{display:inline-block;max-width:calc(100% - 104px);overflow:hidden;text-overflow:ellipsis;vertical-align:middle;white-space:nowrap}
.gb-failover-routes li button{margin-left:3px}
.gb-failover-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px}
.gb-failover-error{color:var(--bt-danger);overflow-wrap:anywhere}
.gb-failover-activity{font-size:12px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.gb-chat-heading .gb-failover-activity{max-width:150px}
@media(max-width:600px){.gb-chat-heading .gb-failover-activity{max-width:94px}}
`
