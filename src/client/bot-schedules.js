import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { ScheduleEditor, scheduleLabel } from './bot-schedule-editor.js'
import scheduleStyle from './bot-schedules.css'
import { t } from './team-ui/i18n.js'

const stamp = value => new Date(value).toLocaleString(undefined, {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
})
const click = (text, onClick, disabled = false) =>
  h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick }, text)
const identity = task => ({ id: task.id, sessionId: task.sessionId })

function ScheduleHistory({ client, task, openChat }) {
  const [page, setPage] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const revision = useRef(0)
  const load = useCallback(async (before) => {
    const version = ++revision.current
    setLoading(true)
    setError('')
    try {
      const result = await client.dispatch({ action: 'team-workspace.scheduleHistory', id: task.id, sessionId: task.sessionId, before })
      if (revision.current === version) setPage(old => before ? { ...result, records: [...old.records, ...result.records] } : result)
    } catch (cause) {
      if (revision.current === version) setError(cause.message)
    } finally {
      if (revision.current === version) setLoading(false)
    }
  }, [client, task.id, task.sessionId])
  useEffect(() => {
    void load()
    return () => { revision.current++ }
  }, [load, task.lastDelivery?.messageId])
  return h('section', { className: 'gb-schedule-history', 'aria-label': '投递记录' },
    h('div', { className: 'gb-schedule-heading' }, h('h4', null, '投递记录'), click('刷新记录', () => load(), loading)),
    !page && loading && h('p', { role: 'status' }, '正在读取记录…'),
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    page?.records.length === 0 && h('p', { className: 'bt-set-hint' }, '暂无投递记录。'),
    page?.records.length > 0 && h('ol', null, page.records.map(record =>
      h('li', { key: record.messageId }, h('span', null, stamp(record.deliveredAt) + ' · 已投递'),
        click('打开会话', () => openChat(record.targetSessionId)),
        record.prompt && h('p', null, record.prompt)))),
    page?.nextBefore && click('更早的记录', () => load(page.nextBefore), loading),
    page && !page.nextBefore && page.earlierRecordsUnavailable &&
      h('p', { className: 'bt-set-hint' }, page.earlierRecordsPruned ? '更早的记录已超过保留期限或数量上限。' : '宿主未保存更早的投递记录。'))
}

function TaskCard({ task, target, client, actions, busy, readonly, onEdit, mutate }) {
  const [history, setHistory] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const running = task.executionActive
  const cooling = task.deliveryFloorEndsAt && Date.parse(task.deliveryFloorEndsAt) > Date.now()
  const locked = readonly || busy
  const next = task.status === 'active' ? (task.state === 'overdue' ? '已到期 · ' : '下次 · ') + stamp(task.scheduledAt)
    : task.status === 'paused' ? '已暂停' : '计划已结束'
  return h('article', { className: 'bt-set-card gb-schedule-card', 'aria-label': task.title },
    h('div', { className: 'gb-schedule-heading' }, h('h3', null, task.title), h('span', { className: 'bt-set-hint' }, next)),
    h('p', { className: 'gb-schedule-meta' }, target + ' · ' + scheduleLabel(task)),
    h('p', { className: 'gb-schedule-prompt' }, task.prompt),
    running ? h('p', { className: 'bt-set-hint' }, '会话中有一次投递正在排队或执行。') :
      cooling && h('p', { className: 'bt-set-hint' }, '可再次运行 · ' + stamp(task.deliveryFloorEndsAt)),
    h('div', { className: 'gb-schedule-actions' },
      !readonly && click('立即运行', () => mutate('Run', task), locked || running || cooling),
      !readonly && task.status !== 'ended' && click(task.status === 'paused' ? '恢复' : '暂停',
        () => mutate(task.status === 'paused' ? 'Resume' : 'Pause', task), locked),
      !readonly && click('编辑', () => onEdit(task), locked),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': history, onClick: () => setHistory(!history) }, '投递记录'),
      !readonly && !confirm && click('删除', () => setConfirm(true), locked)),
    confirm && h('div', { className: 'gb-schedule-actions' },
      h('span', null, '删除此任务及其投递记录？'), click('取消', () => setConfirm(false), busy),
      click('确认删除', () => mutate('Delete', task), locked)),
    history && h(ScheduleHistory, { client, task, openChat: id => { actions.closeSettings(); actions.openSession(id) } }))
}

export function BotSchedulesPage({ client, roster, actions, start, initialTarget, publish }) {
  const owner = start?.startsWith('bot:') ? start.slice(4) : start?.startsWith('room:') ? start.slice(5) : ''
  const [filter, setFilter] = useState(owner)
  const [editor, setEditor] = useState(start && !owner && !roster.readOnly ? { target: start } : null)
  const [view, setView] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const lock = useRef(false)
  const sequence = useRef(0)
  const update = useCallback(next => {
    setView(next)
    setLoadError('')
    publish(next)
  }, [publish])
  const reload = useCallback(async () => {
    const token = ++sequence.current
    try {
      const next = await client.dispatch({ action: 'team-workspace.scheduleList' })
      if (mounted.current && token === sequence.current) update(next)
    } catch (cause) {
      if (mounted.current && token === sequence.current) setLoadError(cause.message)
    }
  }, [client, update])
  useEffect(() => {
    mounted.current = true
    let stopped = false, timer
    async function poll() {
      if (!lock.current) await reload()
      if (!stopped) timer = setTimeout(poll, document.hidden ? 30000 : 7000)
    }
    void poll()
    return () => { mounted.current = false; stopped = true; sequence.current++; clearTimeout(timer) }
  }, [reload])
  const targets = [
    ...roster.bots.map(bot => ({ id: bot.id, label: bot.name })),
    ...roster.rooms.map(room => ({ id: room.id, label: '群聊 · ' + room.name })),
  ]
  async function mutate(name, task, fields = {}) {
    if (lock.current || roster.readOnly) return
    lock.current = true
    sequence.current++
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const change = task ? { ...identity(task), expectedUpdatedAt: task.updatedAt ?? null } : {}
      const next = await client.dispatch({ action: 'team-workspace.schedule' + name, ...change, ...fields })
      if (!mounted.current) return
      update(next)
      setEditor(null)
      if (filter && fields.target && fields.target !== filter) setFilter(fields.target)
      setNotice(({ Create: '已创建任务', Edit: '已保存修改', Run: '已投递到会话', Pause: '已暂停', Resume: '已恢复', Delete: '已删除任务' })[name])
    } catch (cause) {
      if (mounted.current) { setError(cause.message); await reload() }
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  function edit(next) {
    setError('')
    setNotice('')
    setEditor(next)
  }
  const tasks = view?.tasks.filter(task => !filter || task.botId === filter || task.roomId === filter) ?? []
  const newTarget = filter || (targets.some(t => t.id === initialTarget) ? initialTarget : targets[0]?.id)
  return h('section', { className: 'gb-bot-schedules', 'aria-label': t('Scheduled messages') },
    h('style', null, scheduleStyle),
    loadError && h('div', { role: 'alert', className: 'gb-error' }, loadError, ' ', click('重新读取', reload, busy)),
    !view && !loadError && h('p', { role: 'status' }, '正在读取自动化任务…'),
    view && !view.available && h('div', { className: 'bt-set-card gb-schedule-card' },
      h('p', null, '在 DSH 插件设置中启用「自动化任务」即可调度 Bot 和群聊。'),
      click('打开插件设置', () => actions.openSettings('dsh', 'plugins'))),
    view?.available && !editor && h('div', { className: 'gb-schedule-toolbar' },
      h('select', { className: 'bt-select', 'aria-label': '筛选执行会话', value: filter, onChange: e => setFilter(e.target.value) },
        h('option', { value: '' }, '所有会话'), ...targets.map(t => h('option', { key: t.id, value: t.id }, t.label))),
      !roster.readOnly && h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || !targets.length,
        onClick: () => edit({ target: newTarget }) }, '新建任务'),
      !roster.readOnly && click('统一创建自动化', () => actions.openSettings('automation', { kind: 'message', id: newTarget }), busy)),
    error && h('p', { role: 'alert', className: 'bt-danger' }, error),
    notice && h('p', { role: 'status', className: 'bt-set-hint' }, notice),
    view?.available && (editor && !roster.readOnly ? h(ScheduleEditor, { key: editor.task?.id ?? 'new', task: editor.task,
      targets, initialTarget: editor.target, busy, cancel: () => edit(null),
      save: fields => mutate(editor.task ? 'Edit' : 'Create', editor.task, fields) })
      : tasks.length ? tasks.map(task => h(TaskCard, { key: task.id, task, client, actions, busy, readonly: !!roster.readOnly,
        target: targets.find(t => t.id === (task.botId ?? task.roomId))?.label ?? task.sessionId, onEdit: task => edit({ task }), mutate }))
        : h('p', { className: 'bt-set-hint' }, filter ? '这个会话暂无自动化任务。' : '暂无自动化任务。')))
}
