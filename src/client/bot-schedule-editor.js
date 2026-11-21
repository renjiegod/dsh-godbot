import { createElement as h, useState } from 'react'

const kinds = [['at', '单次'], ['every', '固定间隔'], ['daily', '每天'], ['weekly', '每周'], ['cron', 'Cron'], ['rrule', '日历规则（RRULE）']]
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const intervalUnits = [[1, '分钟'], [60, '小时'], [1440, '天']]
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const option = ([value, label]) => h('option', { key: value, value }, label)
const field = (label, child) => h('label', { className: 'gb-schedule-field' }, h('span', null, label), child)

function localDate(value) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export function scheduleLabel(task) {
  const clock = (task.time ?? '').replace(/(:00)?\.000$/, '').replace(/^(\d\d:\d\d):00$/, '$1')
  switch (task.kind) {
    case 'after':
    case 'at': return '单次'
    case 'every': return task.everySeconds % 60 ? '每 ' + task.everySeconds + ' 秒' : '每 ' + task.everySeconds / 60 + ' 分钟'
    case 'daily': return '每天 ' + clock + ' · ' + task.timeZone
    case 'weekly': return task.weekdays.map(day => days[day - 1]).join('、') + ' ' + clock + ' · ' + task.timeZone
    case 'cron': return task.expression + ' · ' + task.timeZone
    case 'rrule': return task.rrule
    default: return '自定义规则'
  }
}

function initialTiming(task) {
  const minutes = task?.everySeconds != null ? task.everySeconds / 60 : 60
  const unit = intervalUnits.findLast(([scale]) => minutes % scale === 0)?.[0] ?? 1
  return {
    kind: task?.kind === 'after' ? 'at' : task?.kind ?? 'daily',
    at: localDate(task?.scheduledAt ?? Date.now() + 3600000),
    time: task?.time?.slice(0, 5) ?? '09:00',
    timeZone: task?.timeZone ?? localZone(),
    weekdays: task?.weekdays ?? [1, 2, 3, 4, 5],
    count: String(minutes / unit),
    unit,
    expression: task?.expression ?? '0 9 * * 1-5',
    rrule: task?.rrule ?? '',
  }
}

function timingOf(draft) {
  switch (draft.kind) {
    case 'at': {
      const date = new Date(draft.at)
      if (localDate(date) !== draft.at) throw new Error('此时间在当前时区不存在。')
      return { kind: 'at', at: date.toISOString() }
    }
    case 'every': return { kind: 'every', minutes: Number(draft.count) * draft.unit }
    case 'cron': return { kind: 'cron', expression: draft.expression.trim(), timeZone: draft.timeZone.trim() }
    case 'rrule': return { kind: 'rrule', rrule: draft.rrule.trim() }
    case 'weekly': return { kind: 'weekly', weekdays: draft.weekdays, time: draft.time, timeZone: draft.timeZone.trim() }
    case 'daily': return { kind: 'daily', time: draft.time, timeZone: draft.timeZone.trim() }
  }
}

export function ScheduleEditor({ task, targets, initialTarget, busy, save, cancel }) {
  const [draft, setDraft] = useState(() => initialTiming(task))
  const [target, setTarget] = useState(task?.botId ?? task?.roomId ?? initialTarget ?? targets[0]?.id ?? '')
  const [title, setTitle] = useState(task?.title ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [problem, setProblem] = useState('')
  const [replaceTiming, setReplaceTiming] = useState(!task)
  const change = (key, value) => setDraft(old => ({ ...old, [key]: value }))
  const input = (key, props) => h('input', { ...props, value: draft[key], required: true, onChange: e => change(key, e.target.value) })
  const isCalendar = ['daily', 'weekly', 'cron'].includes(draft.kind)
  function submit(e) {
    e.preventDefault()
    setProblem('')
    const fields = { title: title.trim(), prompt: prompt.trim(), target }
    if (task && target === (task.botId ?? task.roomId)) delete fields.target
    if (replaceTiming) {
      if (draft.kind === 'weekly' && !draft.weekdays.length) return setProblem('请至少选择一天。')
      try { fields.when = timingOf(draft) } catch { return setProblem('请选择有效的日期和时间。') }
    }
    void save(fields)
  }
  return h('form', { className: 'bt-set-card gb-schedule-form', onSubmit: submit, 'aria-label': task ? '编辑自动化任务' : '新建自动化任务' },
    h('h3', null, task ? '编辑任务' : '新建任务'),
    h('fieldset', { disabled: busy },
      field('任务名称', h('input', { name: 'title', required: true, maxLength: 120, autoFocus: true, value: title, onChange: e => setTitle(e.target.value) })),
      field('执行会话', h('select', { value: target, required: true, onChange: e => setTarget(e.target.value) }, targets.map(t => option([t.id, t.label])))),
      field('任务指令', h('textarea', { name: 'prompt', required: true, rows: 3, value: prompt, onChange: e => setPrompt(e.target.value) })),
      task && h('label', { className: 'gb-schedule-check' }, h('input', { type: 'checkbox', checked: replaceTiming, onChange: e => setReplaceTiming(e.target.checked) }), '更改执行时间'),
      !replaceTiming && h('p', { className: 'bt-set-hint' }, scheduleLabel(task)),
      replaceTiming && h('div', { className: 'gb-schedule-grid' },
        field('重复方式', h('select', { value: draft.kind, onChange: e => change('kind', e.target.value) }, kinds.map(option))),
        draft.kind === 'at' && field('执行时间（' + localZone() + '）', input('at', { type: 'datetime-local' })),
        draft.kind === 'every' && field('重复间隔', input('count', { type: 'number', min: 1, step: 1 })),
        draft.kind === 'every' && field('间隔单位', h('select', { value: draft.unit, onChange: e => change('unit', Number(e.target.value)) }, intervalUnits.map(option))),
        ['daily', 'weekly'].includes(draft.kind) && field('时间', input('time', { type: 'time' })),
        draft.kind === 'weekly' && h('fieldset', { className: 'gb-schedule-days' }, h('legend', null, '执行日'),
          ...days.map((label, i) => h('label', { key: label }, h('input', { type: 'checkbox',
            checked: draft.weekdays.includes(i + 1), onChange: e => change('weekdays', e.target.checked
              ? [...draft.weekdays, i + 1].sort() : draft.weekdays.filter(day => day !== i + 1)) }), label))),
        draft.kind === 'cron' && field('Cron 表达式（分 时 日 月 周）', input('expression', { spellCheck: false })),
        draft.kind === 'rrule' && field('iCalendar 规则', h('textarea', { rows: 3, required: true, value: draft.rrule, spellCheck: false,
          placeholder: 'DTSTART:20300101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=1MO', onChange: e => change('rrule', e.target.value) })),
        isCalendar && field('时区', input('timeZone', { placeholder: 'Asia/Taipei', spellCheck: false })))),
    problem && h('p', { role: 'alert', className: 'bt-danger' }, problem),
    h('div', { className: 'gb-schedule-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: cancel }, '取消'),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy || !target || !prompt.trim() || !title.trim() },
        task ? '保存修改' : '创建任务')))
}
