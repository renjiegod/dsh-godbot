import { createElement as h, useState } from 'react'
import { dateLocale, t } from './team-ui/i18n.js'

export const targetLabels = { message: 'Conversation message', task: 'Bot assignment', workflow: 'Workflow' }
export const filterLabels = { all: 'All', message: 'Chat messages', task: 'Assignments', workflow: 'Workflows' }
const timingLabels = { once: 'Once', interval: 'Repeat', daily: 'Every day', weekly: 'Every week', cron: 'Cron', rrule: 'Calendar rule (RRULE)' }
const days = [1, 2, 3, 4, 5, 6, 7]
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const weekday = day => new Intl.DateTimeFormat(dateLocale(), { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, day))
const option = (value, label) => h('option', { key: value, value }, label)
const field = (label, input) => h('label', { className: 'gb-auto-field' }, h('span', null, t(label)), input)
const input = (name, props) => h('input', { id: 'automation-' + name, name, className: 'bt-input', required: true, ...props })
const select = (label, props, choices) => field(label, h('select', { className: 'bt-select', ...props }, choices))
const textArea = (name, props) => h('textarea', { name, className: 'bt-input bt-input-area', rows: 3, required: true, ...props })

export const formatDate = value => new Intl.DateTimeFormat(dateLocale(), {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(value))

export function triggerText(trigger) {
  if (trigger.kind === 'webhook') return 'Webhook'
  if (trigger.kind === 'github') return [trigger.repo, trigger.eventType].filter(Boolean).join(' · ')
  const when = trigger.when
  if (!when) return t('Custom schedule')
  if (when.kind === 'once') return t('Once')
  if (when.kind === 'interval') {
    if (when.seconds % 60) return t('Every {count} seconds', { count: when.seconds })
    if (when.minutes % 1440 === 0) return t('Every {count} days', { count: when.minutes / 1440 })
    if (when.minutes % 60 === 0) return t('Every {count} hours', { count: when.minutes / 60 })
    return t('Every {count} minutes', { count: when.minutes })
  }
  if (when.kind === 'rrule') return t('Calendar rule (RRULE)')
  const clock = when.time?.replace(/^(\d\d:\d\d):00(?:\.000)?$/, '$1').replace(/\.000$/, '')
  const description = when.kind === 'cron' ? t('On the schedule {expression}', { expression: when.expression })
    : when.kind === 'weekly' ? t('Every {days} at {time}', { days: when.weekdays?.map(weekday).join('、'), time: clock })
    : t('Every day at {time}', { time: clock })
  return [description, when.timeZone].filter(Boolean).join(' · ')
}

function localTime(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

function scheduleInput(fields, kind) {
  if (kind === 'once') {
    const value = String(fields.get('at'))
    const date = new Date(value)
    if (localTime(date).slice(0, value.length) !== value) throw new Error(t('Pick a valid date and time.'))
    return { kind, at: date.toISOString() }
  }
  if (kind === 'interval') return { kind, minutes: Number(fields.get('minutes')) * Number(fields.get('unit')) }
  if (kind === 'cron') return { kind, expression: fields.get('expression').trim(), timeZone: fields.get('timeZone').trim() }
  if (kind === 'rrule') return { kind, rrule: fields.get('rrule').trim() }
  const weekdays = fields.getAll('day').map(Number)
  if (kind === 'weekly' && !weekdays.length) throw new Error(t('Pick at least one day.'))
  return { kind, time: fields.get('time'), timeZone: fields.get('timeZone').trim(), ...(kind === 'weekly' ? { weekdays } : {}) }
}

function TimingFields({ kind, original, message }) {
  if (kind === 'once') return field(t('Run at ({zone})', { zone: localZone() }),
    input('at', { type: 'datetime-local', step: 1, defaultValue: localTime(original?.at ?? Date.now() + 3600_000) }))
  if (kind === 'interval') {
    const minutes = Number.isInteger(original?.minutes) ? original.minutes : 60
    const unit = [1440, 60, 1].find(scale => minutes % scale === 0)
    return h('div', { className: 'gb-auto-grid' },
      field('Interval', input('minutes', { type: 'number', min: 1, step: 1, defaultValue: minutes / unit })),
      select('Unit', { name: 'unit', defaultValue: unit }, [option(1, t('minutes')), option(60, t('hours')), option(1440, t('days'))]))
  }
  if (kind === 'rrule') return field('Calendar rule (RRULE)',
    textArea('rrule', { defaultValue: original?.rrule, spellCheck: false, placeholder: 'DTSTART:20300101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=1MO' }))
  return h('div', { className: 'gb-auto-grid' },
    kind === 'cron'
      ? field('Cron expression', input('expression', { defaultValue: original?.expression, placeholder: '0 9 * * 1-5', spellCheck: false }))
      : field('Time', input('time', { type: 'time', step: message ? 1 : 60, defaultValue: original?.time?.split('.')[0] ?? '09:00' })),
    field('Time zone', input('timeZone', { defaultValue: original?.timeZone ?? localZone(), spellCheck: false })),
    kind === 'weekly' && h('fieldset', { className: 'gb-auto-days' },
      h('legend', null, t('Days of the week')),
      days.map(day => h('label', { key: day },
        h('input', { type: 'checkbox', name: 'day', value: day, defaultChecked: (original?.weekdays ?? [1, 2, 3, 4, 5]).includes(day) }),
        weekday(day)))))
}

export function AutomationEditor({ item, initial, view, bots, rooms, busy, onSave, onCancel, openPlugins, openWorkflows }) {
  const [type, setType] = useState(item?.target.kind ?? initial?.kind ?? (view.available ? 'message' : 'task'))
  const [trigger, setTrigger] = useState('schedule')
  const original = item?.trigger.when
  const [kind, setKind] = useState(original?.kind ?? 'daily')
  const [replaceTiming, setReplaceTiming] = useState(!item)
  const [targetId, setTargetId] = useState(item?.target.id ?? initial?.id ?? '')
  const [problem, setProblem] = useState('')
  const options = type === 'workflow' ? view.workflows : type === 'task' ? bots : [...bots, ...rooms]
  const pinned = item?.target.kind === 'workflow' && item.target.id === targetId ? item.target : null
  const target = options.find(row => row.id === targetId) ?? pinned
  const versions = [...new Set([target?.revision, pinned?.revision].filter(Boolean))].sort((a, b) => b - a)
  const instructions = type === 'message' ? 'Message or instructions' : 'Instructions and acceptance criteria'
  const canCreateMessage = view.available || type !== 'message'
  const typeOptions = Object.entries(targetLabels).filter(([key]) =>
    !item || (item.source === 'message' ? key === 'message' : key !== 'message'))
  function changeType(next) {
    setType(next)
    setTargetId('')
    if (next === 'message') setTrigger('schedule')
    else if (['cron', 'rrule'].includes(kind)) setKind('daily')
  }
  function submit(event) {
    event.preventDefault()
    if (busy || !target || !canCreateMessage) return
    const fields = new FormData(event.currentTarget)
    const request = {
      title: fields.get('title').trim(),
      instructions: type === 'workflow' ? undefined : fields.get('instructions').trim(),
      target: { kind: type, id: target.id, ...(type === 'workflow' ? { revision: Number(fields.get('revision')) } : {}) },
    }
    if (!request.title || request.instructions === '') {
      setProblem(t('Enter a name and the instructions.'))
      return
    }
    setProblem('')
    try {
      const when = trigger === 'schedule' && replaceTiming ? scheduleInput(fields, kind) : undefined
      if (item) {
        if (type === 'message' && target.id === item.target.id) delete request.target
        onSave({ ...request, when })
      } else {
        onSave({ ...request, checkOnly: fields.get('executionMode') === 'check',
          trigger: { kind: trigger, ...(when ? { when } : trigger === 'github'
            ? { repo: fields.get('repo').trim(), eventType: fields.get('eventType').trim(), includeLatest: fields.has('includeLatest') } : {}) } })
      }
    } catch (error) {
      setProblem(error.message)
    }
  }
  return h('form', { className: 'bt-set-card gb-auto-editor', 'aria-label': t(item ? 'Edit automation' : 'New automation'), onSubmit: submit },
    h('h3', null, t(item ? 'Edit automation' : 'New automation')),
    h('fieldset', { disabled: busy, className: 'gb-auto-fields' },
      h('div', { className: 'gb-auto-grid' },
        field('Automation name', input('title', { autoFocus: true, maxLength: type === 'message' ? 120 : 32000, defaultValue: item?.title })),
        select('Action', { value: type, onChange: e => changeType(e.target.value) }, typeOptions.map(([key, label]) => option(key, t(label)))),
        select('Target', { value: target?.id ?? '', required: true, onChange: e => setTargetId(e.target.value) },
          [option('', t('Choose a target')), ...options.map(row => option(row.id, row.sessionId && rooms.some(room => room.id === row.id) ? t('Group · {name}', { name: row.name }) : row.name)),
            ...(pinned && !options.some(row => row.id === pinned.id) ? [option(pinned.id, pinned.name ?? pinned.id)] : [])]),
        type === 'workflow' && h('div', null,
          select('Pinned revision', { key: targetId, name: 'revision', defaultValue: pinned?.revision ?? target?.revision, required: true },
            versions.map(revision => option(revision, 'v' + revision))),
          !options.length && !pinned && h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: openWorkflows }, t('Open task board'))),
        !item && select('Trigger', { value: trigger, onChange: e => setTrigger(e.target.value) }, [
          option('schedule', t('On a schedule')),
          ...(type !== 'message' ? [option('webhook', 'Webhook'), option('github', t('GitHub public repository event'))] : []),
        ])),
      type !== 'workflow' && field(instructions, textArea('instructions', {
        key: instructions, defaultValue: item?.target.kind === type ? item.instructions : undefined,
        maxLength: type === 'task' ? 32000 : undefined,
      })),
      item && h('label', { className: 'gb-auto-check' },
        h('input', { type: 'checkbox', checked: replaceTiming, onChange: e => setReplaceTiming(e.target.checked) }), t('Change schedule')),
      trigger === 'schedule' && replaceTiming && h('div', { className: 'gb-auto-fields' },
        select('Frequency', { value: kind, onChange: e => setKind(e.target.value) },
          Object.entries(timingLabels).filter(([value]) => type === 'message' || !['cron', 'rrule'].includes(value))
            .map(([value, label]) => option(value, t(label)))),
        h(TimingFields, { key: kind, kind, message: type === 'message', original: original?.kind === kind ? original : undefined })),
      trigger === 'github' && h('div', { className: 'gb-auto-grid' },
        field('Repository', input('repo', { placeholder: 'owner/repository', spellCheck: false })),
        field('Event type', input('eventType', { placeholder: 'IssuesEvent', spellCheck: false, required: false })),
        h('label', { className: 'gb-auto-check' }, h('input', { type: 'checkbox', name: 'includeLatest' }), t('Process the latest matching event'))),
      trigger === 'webhook' && h('p', { className: 'bt-set-hint' }, t('Save the URL and signing secret shown after creation.')),
      !item && select('Execution policy', { name: 'executionMode' }, [option('normal', t('Use Bot and workspace policy')), option('check', t('Check and report only'))])),
    problem && h('p', { role: 'alert', className: 'gb-auto-error' }, problem),
    !canCreateMessage && h('div', { className: 'gb-auto-actions' }, h('span', { className: 'bt-set-hint' }, t('Switch on Automation tasks on the Plugins page in Settings.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: openPlugins }, t('Open Plugins'))),
    h('div', { className: 'gb-auto-actions gb-auto-footer' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy || !target || !canCreateMessage },
        t(busy ? 'Saving…' : item ? 'Save changes' : 'Create automation'))))
}
