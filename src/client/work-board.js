import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './team-ui/api.js'
import { t, dateLocale } from './team-ui/i18n.js'
import {
  actionNames,
  defaultFilters,
  markNames,
  phaseIcons,
  phaseNames,
  sourceNames,
  useWorkBoard,
} from '../host/team-runtime/shared/work-board.js'
import style from './work-board.css'
import { BoardAnchor } from './work-board-anchor.js'

const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label)
const option = (value, label) => h('option', { key: value, value }, label)
const label = (dict, key) => t(dict[key] ?? key ?? 'Unknown')
const when = (value) => (value ? new Date(value).toLocaleString(dateLocale()) : '—')
const storageKey = 'godbot.work-board.preferences.v1'
function prefs() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) ?? {}
  } catch {
    return {}
  }
}
function subscribe(fn) {
  const events = new EventSource('api/godbot/team/feed')
  for (const topic of ['work-board', 'revision', 'hello', 'live']) events.addEventListener(topic, () => fn(topic))
  return () => events.close()
}
function Editor({ form, setForm, view, busy, offline, onSubmit, onBack, item }) {
  const { op, base, child } = form
  const patch = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  const field = (name, control) => h('label', { className: 'wb-field' }, t(name), control)
  const writing = ['create', 'edit', 'dispatch'].includes(op)
  const different = base && item && base.version !== item.version
  const review = op === 'approve' || op === 'reject'
  const needsText = ['reject', 'note'].includes(op) || !!child
  return h(
    'form',
    {
      className: 'wb-editor',
      onSubmit: (e) => {
        e.preventDefault()
        onSubmit()
      },
    },
    h('h2', null, label(actionNames, op)),
    writing
      ? h(
          'div',
          null,
          field(
            'Title',
            h('input', {
              required: true,
              maxLength: 160,
              value: form.title,
              readOnly: op === 'dispatch',
              onChange: (e) => patch('title', e.target.value),
            }),
          ),
          field(
            'Owner',
            h(
              'select',
              { value: form.owner, required: op === 'dispatch', onChange: (e) => patch('owner', e.target.value) },
              option('', t('Unassigned')),
              ...(view?.bots ?? []).map((b) => option(b.id, b.name)),
            ),
          ),
          field(
            'Acceptance criteria',
            h('textarea', {
              value: form.criteria,
              required: op === 'dispatch',
              maxLength: 8000,
              onChange: (e) => patch('criteria', e.target.value),
            }),
          ),
          field(
            'Priority',
            h(
              'select',
              { value: form.priority, onChange: (e) => patch('priority', Number(e.target.value)) },
              option(0, t('Normal')),
              option(1, t('High')),
            ),
          ),
          op === 'dispatch'
            ? h(
                'p',
                null,
                form.origin?.botId === form.owner
                  ? t('Dispatch to the source conversation')
                  : t('Dispatch to a dedicated task conversation'),
              )
            : null,
        )
      : null,
    op === 'transfer'
      ? field(
          'New owner',
          h(
            'select',
            { value: form.owner, required: true, onChange: (e) => patch('owner', e.target.value) },
            option('', t('Choose a Bot')),
            ...(view?.bots ?? []).filter((b) => b.id !== base.owner).map((b) => option(b.id, b.name)),
          ),
        )
      : null,
    review
      ? h(
          'section',
          null,
          h('h3', null, t('Evidence'), ' · v', child?.evidenceRevision ?? base?.evidenceRevision),
          h('pre', null, child?.evidence ?? base?.evidence),
        )
      : null,
    review || op === 'note'
      ? field(
          op === 'note' ? 'Message to the group' : 'Review feedback',
          h('textarea', {
            required: needsText,
            maxLength: op === 'note' ? 500 : 8000,
            value: form.text,
            onChange: (e) => patch('text', e.target.value),
          }),
        )
      : null,
    op === 'note' ? h('p', null, t('This posts a message to the source group and mentions the owner.')) : null,
    different
      ? h(
          'p',
          { className: 'gb-alert', role: 'alert' },
          t('This work item changed. Reopen the action to review the current evidence.'),
        )
      : null,
    h(
      'footer',
      null,
      button(t('Back'), onBack),
      h(
        'button',
        { className: 'wb-primary', type: 'submit', disabled: busy || offline || different },
        t('Confirm'),
      ),
    ),
  )
}

export function WorkBoard({ initial, actions, roster, column = 0 }) {
  const [filter, setFilter] = useState(() => ({ ...defaultFilters, ...prefs().filters, ...initial.filters }))
  const [layout, setLayout] = useState(() => (prefs().layout === 'list' ? 'list' : 'board'))
  const [selection, setSelection] = useState(
    () => initial.id ?? (initial.taskId ? { taskId: initial.taskId } : null),
  )
  const createForm = (seed = {}) => ({
    op: 'create',
    title: seed.title ?? '',
    criteria: '',
    priority: 0,
    owner: filter.owner === 'unassigned' ? '' : filter.owner,
    room: filter.room || seed.origin?.roomId || '',
    origin: seed.origin,
    text: '',
  })
  const [form, setForm] = useState(() => (initial.seed ? createForm(initial.seed) : null))
  const [anchor, setAnchor] = useState(null)
  const panel = useRef(null),
    opener = useRef(null),
    last = useRef(null)
  const { view, item, error, busy, reachable, accessGone, refresh, refreshAt, more, earlier, act } = useWorkBoard({
    call,
    subscribe,
    online: true,
    identity: roster.dataPath,
    filters: filter,
    selected: selection,
  })
  useEffect(() => {
    if (accessGone) {
      setForm(null)
      setAnchor(null)
    }
  }, [accessGone])
  const readOnly = !!(roster.readOnly || view?.readOnly || !reachable)
  const editFilter = (k, v) => setFilter((f) => ({ ...f, [k]: v }))
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ layout, filters: { ...filter, search: '' } }))
    } catch {}
  }, [layout, filter])
  const route = (id) =>
    history.replaceState(
      history.state,
      '',
      location.pathname + location.search + '#/godbot/work' + (id ? '/' + id : ''),
    )
  const pick = (id, focus = true) => {
    if (focus) opener.current = document.activeElement
    setForm(null)
    setSelection(id)
    route(typeof id === 'string' ? id : null)
  }
  const closeDetail = () => {
    if (anchor) {
      setAnchor(null)
      return
    }
    if (form && selection) {
      setForm(null)
      return
    }
    setForm(null)
    setSelection(null)
    route(null)
    requestAnimationFrame(() => opener.current?.focus?.())
  }
  useEffect(() => {
    if (!selection && !form) return
    const node = panel.current
    node?.focus({ preventScroll: true })
    const keys = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeDetail()
      }
      if (e.key === 'Tab' && node) {
        const list = [
          ...node.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)',
          ),
        ]
        if (!list.length) return
        if (e.shiftKey && (document.activeElement === list[0] || document.activeElement === node)) {
          e.preventDefault()
          list.at(-1).focus()
        } else if (!e.shiftKey && document.activeElement === list.at(-1)) {
          e.preventDefault()
          list[0].focus()
        }
      }
    }
    node?.addEventListener('keydown', keys)
    return () => node?.removeEventListener('keydown', keys)
  }, [selection, form?.op, anchor])
  const begin = (op, base = item, child = null) => {
    setForm({
      op,
      base,
      child,
      title: base?.title || '',
      criteria: base?.criteria || '',
      owner: op === 'transfer' ? '' : base?.owner || '',
      priority: base?.priority || 0,
      origin: base?.origin,
      text: '',
    })
  }
  async function submit() {
    const { op, base, child, title, owner, criteria, priority, origin, text, room } = form
    const result = await act(
      {
        op,
        id: base?.id,
        version: base?.version,
        childId: child?.id,
        evidenceRevision: child?.evidenceRevision ?? base?.evidenceRevision,
        title,
        owner,
        criteria,
        priority,
        origin,
        text,
        room,
      },
      () => crypto.randomUUID(),
    )
    if (result) {
      setForm(null)
      setSelection(result.id)
      route(result.id)
    }
  }
  function original(anchor) {
    const id = anchor?.sessionId || anchor?.roomId
    if (!id) return
    setAnchor(anchor)
  }
  async function drop(e, phase) {
    e.preventDefault()
    const id = e.dataTransfer.getData('application/x-godbot-work')
    if (!/^GB-\d+$/.test(id) || readOnly) return
    try {
      const base = await call('board-item', { id })
      const op =
        phase === 'doing' && base.actions.includes('dispatch')
          ? 'dispatch'
          : phase === 'done' && base.source !== 'run' && base.actions.includes('approve')
            ? 'approve'
            : null
      if (op) {
        pick(id)
        begin(op, base)
      }
    } catch (cause) {
      actions.reportError?.(cause, 'work board')
    }
  }
  const filterSelect = (k, name, options) =>
    h(
      'select',
      { 'aria-label': t(name), value: filter[k], onChange: (e) => editFilter(k, e.target.value) },
      option('', t(name)),
      ...options,
    )
  const ownerName = (id) => view?.bots.find((b) => b.id === id)?.name || t('Unassigned')
  function card(c) {
    return h(
      'button',
      {
        type: 'button',
        className: 'wb-card',
        key: c.id,
        'data-work-id': c.id,
        draggable: !readOnly && (c.source === 'draft' || (c.phase === 'review' && c.source !== 'run')),
        onDragStart: (e) => e.dataTransfer.setData('application/x-godbot-work', c.id),
        onClick: () => pick(c.id),
      },
      h('small', null, c.id, c.priority ? h('b', null, '↑ ', t('High')) : null),
      h('strong', null, c.title),
      c.hint ? h('span', { className: 'wb-hint' }, c.hint) : null,
      h('span', { className: 'wb-meta' }, ownerName(c.owner), h('em', null, label(markNames, c.mark))),
    )
  }
  function actionButtons(d) {
    return d.source === 'run'
      ? d.children
          .filter((c) => c.status === 'reported')
          .map((c) =>
            h(
              'div',
              { key: c.id },
              h('strong', null, c.target, ' · v', c.evidenceRevision),
              h('pre', null, c.evidence),
              ...d.actions.map((op) => button(label(actionNames, op), () => begin(op, d, c), { key: op })),
            ),
          )
      : d.actions.map((op) =>
          button(label(actionNames, op), () => begin(op, d), {
            key: op,
            className: ['approve', 'dispatch'].includes(op) ? 'wb-primary' : '',
          }),
        )
  }
  const cards = view?.columns ?? []
  const focused = form || !!selection
  useEffect(() => {
    if (!selection || !item || last.current === item.id) return
    last.current = item.id
    route(item.id)
  }, [selection, item])
  return h(
    'section',
    { className: 'wb-shell', style: { left: column }, 'aria-label': t('Work board') },
    h('style', null, style),
    h(
      'div',
      { className: 'wb-main', inert: focused ? true : undefined },
      h(
        'header',
        { className: 'wb-head' },
        h('h1', null, t('Work board')),
        button(
          t('New work item'),
          () => {
            opener.current = document.activeElement
            setForm(createForm())
          },
          { className: 'wb-primary', disabled: readOnly },
        ),
        button('×', actions.closeWorkBoard, { 'aria-label': t('Close work board') }),
      ),
      h(
        'nav',
        { className: 'wb-tabs' },
        ...Object.entries({ all: 'All work', mine: 'Needs my action', history: 'History' }).map(([k, v]) =>
          button(t(v) + ' ' + (view?.counts[k] ?? '…'), () => editFilter('tab', k), {
            key: k,
            'aria-pressed': filter.tab === k,
          }),
        ),
      ),
      h(
        'div',
        { className: 'wb-tools' },
        h('input', {
          type: 'search',
          value: filter.search,
          placeholder: t('Search ID or title'),
          'aria-label': t('Search ID or title'),
          onChange: (e) => editFilter('search', e.target.value),
        }),
        filterSelect('owner', 'All owners', [
          option('unassigned', t('Unassigned')),
          ...(view?.bots ?? []).map((b) => option(b.id, b.name)),
        ]),
        filterSelect(
          'room',
          'All groups',
          (view?.rooms ?? []).map((r) => option(r.id, r.name)),
        ),
        filterSelect(
          'section',
          'All sections',
          (roster.sections ?? []).map((r) => option(r.id, r.name)),
        ),
        filterSelect(
          'source',
          'All sources',
          Object.keys(sourceNames).map((k) => option(k, label(sourceNames, k))),
        ),
        button(t(layout === 'board' ? 'List view' : 'Board view'), () =>
          setLayout(layout === 'board' ? 'list' : 'board'),
        ),
      ),
      roster.readOnly || view?.readOnly ? h('p', { role: 'status' }, t('Read only')) : null,
      !view && !error ? h('p', { role: 'status' }, t('Loading…')) : null,
      view && cards.every((c) => !c.total)
        ? h(
            'p',
            { className: 'wb-empty' },
            t('No matching work items'),
            button(t('Clear filters'), () => setFilter({ ...defaultFilters })),
          )
        : null,
      h(
        'div',
        { className: 'wb-lanes', 'data-layout': layout },
        ...cards.map((c) =>
          h(
            'section',
            {
              className: 'wb-lane',
              key: c.phase,
              'data-phase': c.phase,
              onDragOver: (e) => {
                if (
                  e.dataTransfer.types.includes('application/x-godbot-work') &&
                  ['doing', 'done'].includes(c.phase)
                )
                  e.preventDefault()
              },
              onDrop: (e) => void drop(e, c.phase),
            },
            h(
              'h2',
              null,
              h('span', { 'aria-hidden': true }, phaseIcons[c.phase]),
              ' ',
              label(phaseNames, c.phase),
              h('small', null, c.total),
            ),
            ...c.items.map(card),
            c.next ? button(t('Load more'), () => more(c)) : null,
          ),
        ),
      ),
    ),
    focused
      ? h(
          'div',
          {
            className: 'wb-shade',
            onMouseDown: (e) => {
              if (e.target === e.currentTarget) closeDetail()
            },
          },
          h(
            'section',
            {
              className: 'wb-detail',
              ref: panel,
              role: 'dialog',
              'aria-modal': true,
              'aria-label': t('Work item'),
              tabIndex: -1,
            },
            h(
              'header',
              null,
              h('small', null, item?.id || t('Work item')),
              button('×', closeDetail, { 'aria-label': t('Close') }),
            ),
            anchor && item
              ? h(BoardAnchor, { anchor, actions, back: () => setAnchor(null) })
              : form
                ? h(Editor, {
                    form,
                    setForm,
                    view,
                    busy,
                    offline: readOnly,
                    onSubmit: submit,
                    onBack: closeDetail,
                    item,
                  })
                : !item
                  ? h('p', null, t('Loading…'))
                  : h(
                      'div',
                      null,
                      h('h2', null, item.title),
                      h(
                        'p',
                        null,
                        label(markNames, item.mark),
                        ' · ',
                        ownerName(item.owner),
                        ' · ',
                        label(sourceNames, item.source),
                      ),
                      h('small', null, when(item.updated)),
                      h('h3', null, t('Acceptance criteria')),
                      h('pre', null, item.criteria || '—'),
                      item.evidence
                        ? h(
                            'section',
                            null,
                            h('h3', null, t('Evidence'), ' · v', item.evidenceRevision),
                            h('pre', null, item.evidence),
                          )
                        : null,
                      item.hint ? h('p', null, item.hint) : null,
                      ...item.pending.map((p) =>
                        button(
                          t(p.type === 'question' ? 'Answer question' : 'Review approval'),
                          () => actions.openWorkSession(p),
                          { key: p.id },
                        ),
                      ),
                      item.dependencies.map((d) =>
                        button(d.id + ' · ' + d.title, () => pick(d.id), { key: d.id }),
                      ),
                      item.origin ? button(t('Open source conversation'), () => original(item.origin)) : null,
                      item.execution
                        ? button(t('Open execution conversation'), () => original(item.execution))
                        : null,
                      item.events.length
                        ? h(
                            'details',
                            null,
                            h('summary', null, t('Activity'), ' · ', item.events.length),
                            ...item.events.map((e, i) =>
                              h(
                                'div',
                                { key: i },
                                h('small', null, e.kind, ' · ', when(e.at), e.attempt ? ' · #' + e.attempt : ''),
                                h('pre', null, e.text),
                                e.execution
                                  ? button(t('Open execution conversation'), () => original(e.execution))
                                  : null,
                              ),
                            ),
                          )
                        : null,
                      item.eventNext ? button(t('Earlier activity'), earlier) : null,
                      item.children.length
                        ? h(
                            'ul',
                            null,
                            ...item.children.map((c) => h('li', { key: c.id }, c.target, ' · ', c.status)),
                          )
                        : null,
                      !readOnly ? h('footer', null, ...actionButtons(item)) : null,
                    ),
          ),
        )
      : null,
    error
      ? h(
          'div',
          { className: 'wb-error', role: 'alert' },
          error,
          refreshAt ? ' · ' + when(refreshAt) : '',
          button(t('Refresh'), refresh),
        )
      : null,
  )
}
