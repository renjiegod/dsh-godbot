import { createElement as h, useEffect, useRef, useState } from 'react'
import { badge, button, empty, field, option, row, stamp } from './controls.js'

const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const kinds = { daily: '每天', weekly: '每周', interval: '固定间隔', once: '仅一次' }
const states = { active: '已启用', paused: '已暂停', finished: '已结束' }
const runStates = {
  running: '执行中', completed: '已验收', needs_input: '等待处理', failed: '失败',
  unknown: '待核实', skipped: '已跳过', stopped: '团队已停止',
}
const action = (name) => 'automation.routine.' + name

function timingLabel(schedule) {
  if (schedule.kind === 'once') return '仅一次 · ' + stamp(schedule.at)
  if (schedule.kind === 'interval') return '每 ' + schedule.minutes + ' 分钟'
  const days = schedule.kind === 'weekly' ? '周' + schedule.weekdays.map(d => weekdays[d - 1]).join('、') : '每天'
  return days + ' ' + schedule.time + ' · ' + schedule.timeZone
}

function localDate(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

function RoutineForm({ routine, members, workflows, busy, onSave, onCancel }) {
  const original = routine?.schedule ?? {}
  const [kind, setKind] = useState(original.kind ?? 'daily')
  const [target, setTarget] = useState(routine?.target ?? 'member')
  const [workflowId, setWorkflowId] = useState(routine?.workflowId ?? '')
  const [revision, setRevision] = useState(routine?.workflowRevision ?? 0)
  const [error, setError] = useState('')
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const calendar = kind === 'daily' || kind === 'weekly'
  const latest = workflows.find(w => w.id === workflowId)
  const options = [...workflows]
  if (routine?.workflowId && !options.some(w => w.id === routine.workflowId)) {
    options.push({ id: routine.workflowId, name: routine.workflowName, revision: routine.workflowRevision })
  }
  const versions = [...new Set([revision, latest?.revision, workflowId === routine?.workflowId && routine.workflowRevision].filter(Boolean))].sort((a, b) => b - a)
  function chooseWorkflow(id) {
    setWorkflowId(id)
    setRevision(options.find(w => w.id === id)?.revision ?? 0)
  }
  function submit(e) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const schedule = { kind }
    if (kind === 'once') {
      const value = data.get('at')
      schedule.at = value === localDate(original.at) ? original.at : new Date(value).toISOString()
    }
    if (kind === 'interval') schedule.minutes = Number(data.get('minutes'))
    if (calendar) {
      schedule.time = data.get('time')
      schedule.timeZone = data.get('timeZone').trim()
    }
    if (kind === 'weekly') {
      schedule.weekdays = data.getAll('day').map(Number)
      if (!schedule.weekdays.length) return setError('请选择至少一个执行日。')
    }
    setError('')
    if (target === 'workflow' && (!workflowId || !revision)) return setError('请选择要运行的工作流和固定版本。')
    const fields = target === 'workflow' ? { workflowId, workflowRevision: revision }
      : { ownerId: data.get('ownerId'), criteria: data.get('criteria') }
    onSave({ title: data.get('title'), target, schedule, ...fields })
  }
  return h('form', { className: 'gb-card gb-form', onSubmit: submit, 'aria-label': '自动化任务设置' },
    h('h2', null, routine ? '编辑自动化任务' : '新建自动化任务'),
    field('任务名称', h('input', { name: 'title', defaultValue: routine?.title, required: true, autoFocus: true })),
    field('执行类型', h('select', { value: target, onChange: e => setTarget(e.target.value) },
      option('member', 'Bot 任务'), option('workflow', '工作流'))),
    target === 'workflow' && field('工作流模板', h('select', { value: workflowId, required: true, onChange: e => chooseWorkflow(e.target.value) },
      option('', '选择工作流'), options.map(w => option(w.id, w.name + ' · v' + w.revision)))),
    target === 'workflow' && !options.length && empty('在团队管理的任务板保存工作流后即可选择。'),
    target === 'workflow' && !!workflowId && field('固定版本', h('select', { value: revision, onChange: e => setRevision(Number(e.target.value)) },
      versions.map(v => option(String(v), 'v' + v)))),
    target === 'member' && field('负责人', h('select', { name: 'ownerId', defaultValue: routine?.ownerId, required: true },
      members.map(m => option(m.id, m.name)))),
    target === 'member' && field('执行要求与验收条件', h('textarea', { name: 'criteria', rows: 3, defaultValue: routine?.criteria, required: true })),
    field('执行频率', h('select', { value: kind, onChange: e => { setKind(e.target.value); setError('') } },
      Object.entries(kinds).map(([value, label]) => option(value, label)))),
    kind === 'once' && field('执行时间（' + localZone + '）', h('input', {
      type: 'datetime-local', step: 1, name: 'at', defaultValue: localDate(original.at), required: true,
    })),
    kind === 'interval' && field('间隔分钟数', h('input', {
      type: 'number', min: 1, max: 525600, step: 1, name: 'minutes', defaultValue: original.minutes ?? 60, required: true,
    })),
    kind === 'weekly' && h('fieldset', { className: 'gb-checks' },
      h('legend', null, '执行日'),
      weekdays.map((label, i) => h('label', { key: label }, h('input', {
        name: 'day', type: 'checkbox', value: i + 1, defaultChecked: (original.weekdays ?? [1]).includes(i + 1),
      }), '周' + label))),
    calendar && field('每天的执行时间', h('input', { type: 'time', name: 'time', defaultValue: original.time ?? '09:00', required: true })),
    calendar && field('时区', h('input', { name: 'timeZone', defaultValue: original.timeZone ?? localZone, placeholder: 'Asia/Taipei', required: true })),
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    row(h('button', { type: 'submit', className: 'gb-primary', disabled: busy }, '保存任务'), button('取消', onCancel, { disabled: busy })),
  )
}

export function NativeRoutines({ team, members, client, run, onTask, onWorkflowRun, readOnly }) {
  const [routines, setRoutines] = useState(null)
  const [workflows, setWorkflows] = useState([])
  const [editor, setEditor] = useState(null)
  const [confirmId, setConfirmId] = useState(null)
  const [historyId, setHistoryId] = useState(null)
  const [history, setHistory] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, refresh] = useState(0)
  const inFlight = useRef(false)
  useEffect(() => {
    let active = true, timer
    async function load() {
      try {
        const list = await client.dispatch({ action: action('list'), teamId: team.id })
        if (!active) return
        setRoutines(list.routines)
        setWorkflows(list.workflows ?? [])
        if (historyId && list.routines.some(r => r.id === historyId)) {
          const page = await client.dispatch({ action: action('history'), teamId: team.id, id: historyId })
          if (!active) return
          setHistory({ id: historyId, items: page.items })
        }
        setError('')
      } catch (cause) {
        if (active) setError(cause.message)
      } finally {
        if (active) timer = setTimeout(load, document.hidden ? 30_000 : 5_000)
      }
    }
    void load()
    return () => { active = false; clearTimeout(timer) }
  }, [client, team.id, historyId, version])

  async function change(name, args, applied) {
    if (inFlight.current || readOnly) return
    inFlight.current = true
    setBusy(true)
    try {
      await run({ action: action(name), teamId: team.id, ...args }, () => {
        applied?.()
        refresh(v => v + 1)
      })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  if (editor) {
    const existing = editor.id ? editor : null
    return h('section', { className: 'gb-page' }, h(RoutineForm, {
      key: existing?.id ?? 'new', routine: existing, members, workflows, busy, onCancel: () => setEditor(null),
      onSave: fields => change(existing ? 'update' : 'create',
        existing ? { id: existing.id, revision: existing.revision, ...fields } : fields, () => setEditor(null)),
    }))
  }
  return h('section', { className: 'gb-page gb-stack', 'aria-label': '团队自动化任务' },
    h('div', { className: 'gb-sectionhead' }, h('h2', null, team.name),
      button('新建自动化任务', () => setEditor({}), { className: 'gb-primary', disabled: readOnly || !members.length })),
    error && h('p', { role: 'alert', className: 'gb-error' }, error, ' ', button('刷新', () => refresh(v => v + 1))),
    !routines && !error && empty('正在读取自动化任务…'),
    routines?.length === 0 && empty(members.length ? '还没有定时派工的任务。' : '在 Bot 设置中创建 Bot 后即可安排自动化任务。'),
    routines?.map(routine => {
      const { id, revision, title, schedule, status } = routine
      const identity = { id, revision }
      const open = historyId === id
      const records = history?.id === id ? history.items : null
      return h('article', { className: 'gb-card', key: id, 'aria-label': title },
        h('div', { className: 'gb-sectionhead' }, h('h3', { className: 'gb-text' }, title), badge(status, states[status])),
        h('p', null, timingLabel(schedule)),
        h('small', null, routine.workflowId ? routine.workflowName + ' · 固定 v' + routine.workflowRevision
          : members.find(m => m.id === routine.ownerId)?.name ?? routine.ownerId,
          routine.nextAt != null && ' · 下次派工 ' + stamp(routine.nextAt)),
        routine.criteria && h('p', { className: 'gb-text' }, routine.criteria),
        routine.lastError && h('p', { role: 'alert', className: 'gb-error' }, routine.lastError),
        row(button('立即运行', () => change('run', { id }, () => setHistoryId(id)), { disabled: busy || readOnly }),
          button('编辑', () => setEditor(routine), { disabled: busy || !members.length || readOnly }),
          status !== 'finished' && button(status === 'paused' ? '恢复' : '暂停',
            () => change(status === 'paused' ? 'resume' : 'pause', identity), { disabled: busy || readOnly }),
          button('运行记录', () => setHistoryId(open ? null : id), { 'aria-expanded': open }),
          button('删除', () => setConfirmId(id), { disabled: busy || readOnly })),
        confirmId === id && row(h('span', null, '删除此计划？已派发的任务会保留在任务板。'),
          button('确认删除', () => change('delete', identity, () => { setConfirmId(null); if (open) setHistoryId(null) }), { className: 'gb-danger', disabled: busy }),
          button('取消删除', () => setConfirmId(null), { disabled: busy })),
        open && h('section', { className: 'gb-stack', 'aria-label': '运行记录' },
          !records ? empty('正在读取记录…') : !records.length ? empty('暂无运行记录。') : records.map(item =>
            h('div', { key: item.id, className: 'gb-stack' },
              row(h('time', null, stamp(item.at)), h('span', null, item.trigger === 'manual' ? '手动运行' : '定时派工'),
                badge(item.state, runStates[item.state] ?? item.state),
                item.workflowId && h('small', null, '工作流 v' + item.workflowRevision),
                item.workflowId && item.runId ? button('查看工作流运行', () => onWorkflowRun(item.workflowId, item.runId)) :
                  item.rootTaskId && button('查看任务', () => onTask(item.rootTaskId))),
              item.nodes?.length > 0 && h('details', null, h('summary', null, '节点任务（' + item.nodes.length + '）'),
                item.nodes.map(n => h('div', { key: n.nodeId, className: 'gb-row' }, h('span', null, n.title), badge(n.status),
                  button('查看任务', () => onTask(n.taskId), { 'aria-label': '查看任务 ' + n.title })))),
              !item.runId && item.reason && h('small', null, item.reason)))),
      )
    }),
  )
}
