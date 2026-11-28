import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './team-ui/api.js'
import { t } from './team-ui/i18n.js'
import { GearIcon, SlidersIcon } from './team-ui/icons.js'
import { writeClipboard } from './team-ui/dsh-primitives.js'
import { sourceNames, useBoardLookup } from '../host/team-runtime/shared/work-board.js'
import {
  boardLayouts, boardPropertyTypes, boardSorts, cardGroups, filterLink, manualStatuses, priorities, timelineBars,
} from '../team/work-board-planning.js'
import {
  DateChip, LAYOUT_SHORT_LABELS, LayoutIcon, OwnerMark, PHASE_TITLES, PriorityBadge, StatusPill, statusLabel,
} from './work-board-ui.js'

const button = (label, onClick, props) => h('button', { type: 'button', onClick, ...props }, label)
const field = (name, input) => h('label', { className: 'wb-field' }, t(name), input)
const option = (value, label) => h('option', { key: value, value }, label)
const options = (dict) => Object.entries(dict).map(([id, label]) => [id, t(label)])
const textList = (text) => text.split(/[,，\n]/).map(value => value.trim()).filter(Boolean)
const select = (value, change, choices, props) =>
  h('select', { value, onChange: event => change(event.target.value), ...props }, ...choices.map(([id, label]) => option(id, label)))
const input = (value, change, props) => h('input', { value: value ?? '', onChange: e => change(e.target.value), ...props })

export function assigneeChoices(catalog, { execution = false } = {}) {
  return (catalog?.assignees ?? []).filter(person => !execution || person.kind !== 'person')
    .map(person => [person.id, person.kind === 'room' ? t('Group') + ' · ' + person.name : t(person.name)])
}

export function RelationPicker({ title, value, onChange, multi = false, exclude }) {
  const [search, setSearch] = useState('')
  const choices = useBoardLookup(call, search, true)
  const ids = multi ? value ?? [] : value ? [value] : []
  const choose = id => {
    onChange(multi ? [...new Set([...ids, id])] : id)
    setSearch('')
  }
  return h('div', { className: 'wb-relation' },
    field(title, input(search, setSearch, { placeholder: t('Find a work item') })),
    ids.length ? h('div', { className: 'wb-tools' }, ...ids.map(id =>
      button(id + ' ×', () => onChange(multi ? ids.filter(item => item !== id) : ''), { key: id, className: 'wb-btn wb-btn-soft' }))) : null,
    search ? h('div', { className: 'wb-picks' }, ...choices.filter(card => card.id !== exclude && !ids.includes(card.id))
      .map(card => button(card.id + ' · ' + card.title, () => choose(card.id), { key: card.id, className: 'wb-btn' }))) : null,
  )
}

function PropertyInput({ property, catalog, value, change }) {
  const people = assigneeChoices(catalog).filter(([id]) => id.startsWith('person/'))
  switch (property.kind) {
    case 'select': return select(value ?? '', change, [['', t('Not set')], ...property.options.map(item => [item, item])])
    case 'person': return select(value ?? '', change, [['', t('Not set')], ...people])
    case 'multiSelect': case 'people': {
      const choices = property.kind === 'people' ? people : property.options.map(item => [item, item])
      return h('select', {
        multiple: true, value: value ?? [],
        onChange: event => change([...event.currentTarget.selectedOptions].map(option => option.value)),
      }, ...choices.map(([id, label]) => option(id, label)))
    }
    case 'checkbox': return select(value == null ? '' : String(value), raw => change(raw === '' ? null : raw === 'true'),
      [['', t('Not set')], ['true', t('Yes')], ['false', t('No')]])
    case 'number': return input(value, raw => change(raw === '' ? null : Number(raw)), { type: 'number', step: 'any' })
    case 'date': return input(value, change, { type: 'date' })
    case 'url': return input(value, change, { type: 'url', placeholder: 'https://' })
    case 'textList': case 'urlList': return h('textarea', {
      rows: 2, defaultValue: (value ?? []).join('\n'), onChange: event => change(textList(event.target.value)),
    })
    default: return input(value, change, { maxLength: 4000 })
  }
}

export function PlanningFields({ form, setForm, catalog, bulk }) {
  const fields = form.fields ?? {}
  const patch = (key, value) => setForm(old => ({ ...old, fields: { ...old.fields, [key]: value } }))
  const manual = !form.base || form.base.source === 'draft'
  const statusChoices = [
    ...Object.entries(manualStatuses).filter(([, value]) => manual || value.phase === form.base.phase)
      .map(([id, status]) => [id, t(status.name)]),
    ...(catalog?.statuses ?? []).filter(status => !status.archived && (manual || status.phase === form.base.phase))
      .map(status => [status.id, status.name]),
  ]
  return h('div', { className: 'wb-planning-fields' },
    !bulk ? field('Task description', h('textarea', {
      rows: 4, maxLength: 16000, value: fields.description ?? '', onChange: event => patch('description', event.target.value),
    })) : null,
    field('Task status', select(fields.statusId ?? '', value => patch('statusId', value), [['', t('Default status')], ...statusChoices])),
    !bulk ? field('Labels', h('input', {
      key: form.base?.id ?? 'draft', defaultValue: (fields.labels ?? []).join(', '),
      onChange: event => patch('labels', textList(event.target.value)),
    })) : [
      field('Add labels', h('input', { onChange: event => patch('addLabels', textList(event.target.value)) })),
      field('Remove labels', h('input', { onChange: event => patch('removeLabels', textList(event.target.value)) })),
    ],
    h('div', { className: 'wb-tools' },
      field('Start date', input(fields.startDate, value => patch('startDate', value), { type: 'date' })),
      field('Due date', input(fields.dueDate, value => patch('dueDate', value), { type: 'date' }))),
    ...((catalog?.properties ?? []).filter(property => !property.archived).map(property => h('label',
      { key: property.id, className: 'wb-field' }, property.name,
      h(PropertyInput, { property, catalog, value: fields.customValues?.[property.id],
        change: value => patch('customValues', { ...fields.customValues, [property.id]: value }) })))),
    h('details', { open: form.op === 'create' && Boolean(fields.parent) }, h('summary', null, t('Task relationships')),
      h(RelationPicker, { title: 'Parent work item', value: fields.parent, exclude: form.base?.id,
        onChange: value => setForm(old => ({ ...old, fields: { ...old.fields, parent: value, ...(!value ? { stage: 0 } : {}) } })) }),
      fields.parent ? field('Stage', input(fields.stage ?? 0, value => patch('stage', Number(value)), { type: 'number', min: 0, max: 99 })) : null,
      !bulk ? h(RelationPicker, { title: 'Waits for', multi: true, value: fields.blockedBy, exclude: form.base?.id,
        onChange: value => patch('blockedBy', value) }) : null,
      !bulk ? h(RelationPicker, { title: 'Duplicate of', value: fields.duplicateOf, exclude: form.base?.id,
        onChange: value => patch('duplicateOf', value) }) : null),
    !bulk && form.base ? field('Change note', input(fields.reason, value => patch('reason', value), { maxLength: 1000 })) : null,
  )
}

function CatalogEditor({ entry, filters, display, onSave, onClose, busy }) {
  const [model, set] = useState(() => ({ phase: 'todo', propertyType: 'text', visibility: 'private', ...entry,
    ...(entry.kind === 'property' && entry.id ? { propertyType: entry.propertyType } : {}), options: entry.options ?? [] }))
  const [useCurrent, setUseCurrent] = useState(!entry.id)
  const patch = (key, value) => set(prior => ({ ...prior, [key]: value }))
  return h('form', { className: 'wb-config', onSubmit: e => { e.preventDefault(); onSave({
    ...model, filters: useCurrent ? filters : entry.filters, display: useCurrent ? display : entry.display,
  }) } },
  field('Name', input(model.name, value => patch('name', value), { required: true, maxLength: 70 })),
  model.kind === 'status' ? field('Lifecycle group', select(model.phase, value => patch('phase', value), options(PHASE_TITLES), { disabled: !!entry.id })) : null,
  model.kind === 'property' ? field('Property type', select(model.propertyType, value => patch('propertyType', value), options(boardPropertyTypes), { disabled: !!entry.id })) : null,
  model.kind === 'property' && ['select', 'multiSelect'].includes(model.propertyType)
    ? field('Options (one per line)', h('textarea', { defaultValue: model.options.join('\n'), onChange: e => patch('options', textList(e.target.value)) })) : null,
  model.kind === 'view' ? field('Visibility', select(model.visibility, value => patch('visibility', value),
    [['private', t('Private')], ['shared', t('Share by link')]])) : null,
  model.kind === 'view' && entry.id ? field('Use current filters and layout',
    h('input', { type: 'checkbox', checked: useCurrent, onChange: e => setUseCurrent(e.target.checked) })) : null,
  h('div', { className: 'wb-tools' }, button(t('Cancel'), onClose, { className: 'wb-btn' }),
    entry.id && !entry.archived ? button(t('Archive'), () => onSave({ ...entry, op: 'remove' }), { disabled: busy, className: 'wb-btn wb-btn-danger' }) : null,
    h('button', { type: 'submit', className: 'wb-primary', disabled: busy }, t(entry.archived ? 'Restore' : 'Save changes'))))
}

/** Compact toolbar view-switcher + collapsible popovers for secondary filters & board management. */
export function useBoardControls({ catalog, filters, display, setDisplay, setFilter, onApplyView, refresh, readOnly,
  selection, selectedItems, enabled, setEnabled, clearSelection, error, setError, sections = [], resetFilters }) {
  const [panel, setPanel] = useState('')
  const [entry, setEntry] = useState(null)
  const [busy, setBusy] = useState(false)
  const [bulk, setBulk] = useState(null)
  const [result, setResult] = useState(null)
  const pending = useRef(null)
  useEffect(() => {
    if (!panel) return
    const onKey = e => {
      if (e.key === 'Escape') setPanel('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])
  const change = (key, value) => setFilter(old => ({ ...old, [key]: value }))
  const activeProperties = (catalog?.properties ?? []).filter(property => !property.archived)
  const groupChoices = [
    ['phase', t('Status category')], ['status', t('Task status')], ['assignee', t('Owner')],
    ['parent', t('Parent work item')], ['label', t('Label')], ['priority', t('Priority')], ['source', t('Source')],
    ...activeProperties.filter(property => property.kind === 'select').map(p => ['property/' + p.id, p.name]),
  ]
  const secondaryCount = [
    filters.section, filters.source, filters.assignee, filters.statusId, filters.priority,
    filters.label, filters.startBefore, filters.dueBefore, filters.property,
    filters.sort && filters.sort !== 'priority' ? filters.sort : '',
    display.groupBy !== 'phase' ? display.groupBy : '',
    selection,
  ].filter(Boolean).length

  async function command(op, payload) {
    setBusy(true)
    setError('')
    try {
      const key = JSON.stringify({ op, ...payload })
      if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() }
      const response = await call('board-action', { op, requestId: pending.current.id, ...payload })
      pending.current = null
      await refresh()
      return response
    } catch (cause) {
      setError(cause.message)
      return null
    } finally { setBusy(false) }
  }
  const configure = async model => {
    if (await command('configure', { entry: model })) setEntry(null)
  }
  const applyBulk = async e => {
    e.preventDefault()
    const patch = { ...bulk.fields, ...(bulk.priority !== '' ? { priority: Number(bulk.priority) } : {}) }
    if (!Object.keys(patch).length) return
    const response = await command('bulk', { items: selectedItems, patch })
    if (response) {
      setResult(response)
      setBulk(null)
      clearSelection(response.rejected.map(item => item.id))
    }
  }
  const togglePanel = name => setPanel(current => current === name ? '' : name)

  const controls = h('div', { className: 'wb-toolbar-right' },
    h('div', { className: 'wb-seg', role: 'group', 'aria-label': t('Layout') },
      ...Object.keys(boardLayouts).map(kind => h('button', {
        key: kind,
        type: 'button',
        'aria-pressed': display.layout === kind,
        'aria-label': t(boardLayouts[kind]),
        title: t(boardLayouts[kind]),
        onClick: () => setDisplay({
          ...display,
          layout: kind,
          groupBy: kind === 'swimlane' && display.groupBy === 'phase' ? 'parent' : display.groupBy,
        }),
      }, h(LayoutIcon, { kind }), h('span', { className: 'wb-seg-label' }, t(LAYOUT_SHORT_LABELS[kind] ?? boardLayouts[kind]))))),
    catalog ? button(
      [h(SlidersIcon, { key: 'i' }), h('span', { key: 'l' }, t('More filters')),
        secondaryCount ? h('span', { key: 'c', className: 'wb-count-dot' }, secondaryCount) : null],
      () => togglePanel('filters'),
      { className: 'wb-tool-btn', 'aria-expanded': panel === 'filters', 'data-active': secondaryCount > 0 || undefined },
    ) : null,
    catalog ? button(t(enabled ? 'Finish selecting' : 'Select work items'),
      () => { setEnabled(!enabled); clearSelection([]); setBulk(null) },
      { className: 'wb-tool-btn', 'aria-pressed': enabled, 'data-active': enabled || undefined }) : null,
    catalog ? button(
      [h(GearIcon, { key: 'i' }), h('span', { key: 'l' }, t('Manage board'))],
      () => togglePanel('manage'),
      { className: 'wb-tool-btn', 'aria-expanded': panel === 'manage' },
    ) : null,
  )

  const popover = !catalog ? null : h('div', { className: 'wb-management' },
    enabled ? h('div', { className: 'wb-bulk-bar' },
      h('strong', null, t('Selected'), ': ', selectedItems.length),
      selectedItems.length ? button(t('Edit selected ({count})', { count: selectedItems.length }),
        () => { setResult(null); setBulk({ fields: {}, priority: '' }) }, { className: 'wb-primary', disabled: readOnly }) : null,
      button(t('Finish selecting'), () => { setEnabled(false); clearSelection([]); setBulk(null) }, { className: 'wb-btn' }),
    ) : null,
    panel === 'filters' ? h('section', { className: 'wb-popover', 'aria-label': t('More filters') },
      h('div', { className: 'wb-popover-head' },
        h('strong', null, t('More filters')),
        h('div', { className: 'wb-tools' },
          button(t('Clear filters'), () => { resetFilters?.(); setDisplay({ layout: display.layout, groupBy: 'phase' }) }, { className: 'wb-btn wb-btn-soft' }),
          button('×', () => setPanel(''), { className: 'wb-icon-close', 'aria-label': t('Close') }))),
      h('div', { className: 'wb-filter-grid' },
        field('Group by', select(display.groupBy, groupBy => setDisplay({ ...display, groupBy }), groupChoices, { 'aria-label': t('Group by') })),
        field('Sort by', select(filters.sort || 'priority', v => change('sort', v), [
          ...options(boardSorts), ...activeProperties.filter(p => ['number', 'date'].includes(p.kind)).map(p => ['property/' + p.id, p.name]),
        ], { 'aria-label': t('Sort by') })),
        field('Saved views', select(selection ?? '', value => onApplyView(catalog.views.find(view => view.id === value)),
          [['', t('Saved views')], ...catalog.views.map(view => [view.id, view.name])], { 'aria-label': t('Saved views') })),
        field('All sections', select(filters.section ?? '', v => change('section', v),
          [['', t('All sections')], ...sections.map(s => [s.id, s.name])])),
        field('Source', select(filters.source ?? '', v => change('source', v),
          [['', t('All sources')], ...Object.entries(sourceNames).map(([k, l]) => [k, t(l)])])),
        field('Owner', select(filters.assignee ?? '', v => change('assignee', v), [['', t('All owners')], ...assigneeChoices(catalog)])),
        field('Task status', select(filters.statusId ?? '', v => change('statusId', v), [
          ['', t('All statuses')], ...Object.entries(manualStatuses).map(([id, status]) => [id, t(status.name)]),
          ...catalog.statuses.filter(status => !status.archived).map(status => [status.id, status.name]),
        ])),
        field('Priority', select(filters.priority ?? '', v => change('priority', v), [['', t('All priorities')], ...options(priorities)])),
        field('Label', input(filters.label, v => change('label', v), { placeholder: t('Label') })),
        field('Start on or before', input(filters.startBefore, v => change('startBefore', v), { type: 'date' })),
        field('Due on or before', input(filters.dueBefore, v => change('dueBefore', v), { type: 'date' })),
        field('Custom property', select(filters.property ?? '', v => setFilter(old => ({ ...old, property: v, propertyValue: '' })),
          [['', t('All properties')], ...activeProperties.map(p => [p.id, p.name])])),
        filters.property ? field('Property value', input(filters.propertyValue, v => change('propertyValue', v))) : null),
    ) : null,
    panel === 'manage' ? h('section', { className: 'wb-popover', 'aria-label': t('Manage board') },
      h('div', { className: 'wb-popover-head' },
        h('strong', null, t('Manage board')),
        h('div', { className: 'wb-tools' },
          button(t('Save view'), () => setEntry({ kind: 'view' }), { className: 'wb-btn', disabled: readOnly }),
          button(t('New status'), () => setEntry({ kind: 'status' }), { className: 'wb-btn', disabled: readOnly }),
          button(t('New property'), () => setEntry({ kind: 'property' }), { className: 'wb-btn', disabled: readOnly }),
          button('×', () => setPanel(''), { className: 'wb-icon-close', 'aria-label': t('Close') }))),
      h('div', { className: 'wb-tools' },
        ...[
          ...catalog.statuses.map(value => ({ ...value, kind: 'status' })),
          ...catalog.properties.map(value => ({ ...value, propertyType: value.kind, kind: 'property' })),
          ...catalog.views.map(value => ({ ...value, kind: 'view' })),
        ].map(item => h('div', { className: 'wb-tools', key: item.id },
          button(item.name + (item.archived ? ' · ' + t('Archived') : ''), () => setEntry(item), { disabled: readOnly, className: 'wb-btn wb-btn-soft' }),
          item.kind === 'view' && item.visibility === 'shared'
            ? button(t('Copy view link'), async () => {
                try { await writeClipboard(new URL(filterLink(item.id), location.href).href) }
                catch (cause) { setError(cause.message) }
              }, { className: 'wb-btn' }) : null))),
    ) : null,
    entry ? h(CatalogEditor, { key: entry.id ?? entry.kind, entry, filters, display, onSave: configure, onClose: () => setEntry(null), busy }) : null,
    bulk ? h('form', { className: 'wb-config', onSubmit: applyBulk },
      field('Owner', select(bulk.fields.assignee ?? '', value => setBulk(old => ({ ...old, fields: { ...old.fields, assignee: value } })),
        [['', t('Choose an owner')], ...assigneeChoices(catalog)])),
      field('Priority', select(bulk.priority, priority => setBulk(old => ({ ...old, priority })), [['', t('Choose priority')], ...options(priorities)])),
      h(PlanningFields, { form: bulk, setForm: setBulk, catalog, bulk: true }),
      h('div', { className: 'wb-tools' }, button(t('Cancel'), () => setBulk(null), { className: 'wb-btn' }),
        h('button', { type: 'submit', className: 'wb-primary', disabled: busy || readOnly }, t('Apply changes')))) : null,
    result ? h('div', { role: 'status', className: 'wb-bulk-result' },
      t('{count} work items updated', { count: result.applied.length }),
      ...result.rejected.map(item => h('div', { key: item.id }, item.id + ' · ' + item.reason))) : null,
    error ? h('p', { className: 'gb-alert', role: 'alert' }, error) : null,
  )

  return { controls, popover }
}

export function boardGroupName(key, group, catalog) {
  if (['phase', 'status'].includes(group)) return t(PHASE_TITLES[key] ?? manualStatuses[key]?.name ??
    catalog?.statuses.find(status => status.id === key)?.name ?? key)
  if (group === 'assignee') return t(assigneeChoices(catalog).find(([id]) => id === key)?.[1] ?? 'Unassigned')
  if (group === 'priority') return t(priorities[key] ?? 'No priority')
  return key || t('Unassigned')
}

export function BoardLayouts({ display, columns, catalog, view, roster, renderCard, open, more, toggle, enabled, selected }) {
  const items = columns.flatMap(column => column.items)
  const groups = cardGroups(columns, display.groupBy)
  const head = group => boardGroupName(group.key, display.groupBy, catalog)
  const properties = (catalog?.properties ?? []).filter(property => !property.archived)
  const load = columns.filter(column => column.next).map(column => button(
    t('Load more') + ' · ' + t(PHASE_TITLES[column.phase]), () => more(column), { key: column.phase, className: 'wb-btn wb-btn-soft' }))
  let content
  if (display.layout === 'table') {
    content = h('div', { className: 'wb-table-scroll' }, h('table', null,
      h('thead', null, h('tr', null, ...(enabled ? [h('th', { key: 'select' }, t('Select'))] : []),
        ...['Title', 'Task status', 'Owner', 'Priority', 'Start date', 'Due date', 'Labels'].map(name => h('th', { key: name }, t(name))),
        ...properties.map(property => h('th', { key: property.id }, property.name)))),
      h('tbody', null, ...groups.flatMap(group => [
        h('tr', { key: 'group/' + group.key, className: 'wb-table-group' },
          h('th', { colSpan: 7 + properties.length + Number(enabled) }, head(group), ' · ', group.items.length)),
        ...group.items.map(card => h('tr', { key: card.id },
          enabled ? h('td', null, h('input', { type: 'checkbox', 'aria-label': t('Select') + ' ' + card.id, checked: selected.has(card.id),
            onChange: () => toggle(card) })) : null,
          h('td', null, h('button', { type: 'button', className: 'wb-table-title', onClick: () => open(card.id) },
            h('span', { className: 'wb-card-id' }, card.id), h('span', null, card.title))),
          h('td', null, h(StatusPill, { phase: card.phase, label: statusLabel(card, catalog) })),
          h('td', null, h(OwnerMark, { target: card, view, roster, size: 18 })),
          h('td', null, h(PriorityBadge, { priority: card.priority, showNormal: true })),
          h('td', null, card.startDate ? h(DateChip, { value: card.startDate, phase: card.phase, prefix: 'start' }) : '—'),
          h('td', null, card.dueDate ? h(DateChip, { value: card.dueDate, phase: card.phase }) : '—'),
          h('td', null, card.labels?.length
            ? h('div', { className: 'wb-card-chips' }, ...card.labels.map((l, i) => h('span', { key: i, className: 'wb-chip' }, l)))
            : '—'),
          ...properties.map(property => {
            const v = card.customValues?.[property.id]
            return h('td', { key: property.id }, (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)) || '—')
          }))),
      ]))))
  } else if (display.layout === 'gantt') {
    const { bars, unscheduled, first, last } = timelineBars(items)
    content = h('div', { className: 'wb-timeline' },
      bars.length ? h('div', { className: 'wb-timeline-range' }, first, ' → ', last) : null,
      ...bars.map(({ card, left, width }) => h('div', { key: card.id, className: 'wb-timeline-row' },
        renderCard(card),
        h('div', { className: 'wb-timeline-track', 'data-phase': card.phase, 'aria-label': [card.startDate, card.dueDate].filter(Boolean).join(' – ') },
          h('button', { type: 'button', title: card.id + ' · ' + card.title, onClick: () => open(card.id),
            style: { left: 100 * left + '%', width: 100 * width + '%' } }, card.id)))),
      unscheduled.length ? h('h3', null, t('Unscheduled')) : null,
      unscheduled.length ? h('div', { className: 'wb-unscheduled-grid' }, ...unscheduled.map(renderCard)) : null)
  } else if (display.layout === 'swimlane') {
    content = groups.map(group => h('section', { key: group.key, className: 'wb-swimlane' },
      h('h2', null, head(group), h('span', { className: 'wb-tab-badge' }, group.items.length)),
      h('div', { className: 'wb-lanes' }, ...columns.map(column =>
        h('div', { key: column.phase, className: 'wb-lane', 'data-phase': column.phase },
          h('h3', null, t(PHASE_TITLES[column.phase]), h('small', null, group.items.filter(c => c.phase === column.phase).length)),
          ...group.items.filter(card => card.phase === column.phase).map(renderCard))))))
  } else {
    content = h('div', { className: 'wb-lanes', 'data-layout': display.layout },
      ...groups.map(group => h('section', { className: 'wb-lane', key: group.key, 'data-phase': display.groupBy === 'status' ? group.key : undefined },
        h('h2', null, head(group), h('small', null, group.items.length)), ...group.items.map(renderCard))))
  }
  return h('div', null, content, load.length ? h('div', { className: 'wb-tools', style: { marginTop: '10px' } }, ...load) : null)
}
