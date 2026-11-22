import { createElement as h, useEffect, useRef, useState } from 'react'
import { ChevronRightIcon } from './team-ui/icons.js'

const destinations = {
  messages: ['schedules', '查看会话日程'],
  routines: ['routines', '查看定时派工'],
  events: ['tasks', '查看事件设置'],
}
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const targets = [['message', '在会话执行'], ['task', '派工并验收'], ['workflow', '运行已保存工作流']]
const sharedTimings = [['once', '一次'], ['interval', '固定间隔'], ['daily', '每天'], ['weekly', '每周']]

const DefaultSection = ({ title, action = null, className = '', children }) =>
  h('section', { className: `bt-set-section ${className}`.trim() },
    action ? h('div', { className: 'bt-la-sec-head' }, h('h3', null, title), action) : title ? h('h3', null, title) : null,
    h('div', { className: 'bt-set-card' }, children))

const DefaultRow = ({ label, hint, children, className = '' }) =>
  h('div', { className: `bt-set-row ${className}`.trim() },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: 'bt-set-control' }, children) : null)

function timing(form, kind) {
  if (kind === 'once') return { kind, at: new Date(form.get('when')).toISOString() }
  if (kind === 'interval') return { kind, minutes: Number(form.get('minutes')) }
  if (kind === 'cron') return { kind, expression: form.get('expression'), timeZone: form.get('timeZone') }
  if (kind === 'rrule') return { kind, rrule: form.get('rrule') }
  return {
    kind, time: form.get('time'), timeZone: form.get('timeZone'),
    ...(kind === 'weekly' ? { weekdays: form.getAll('day').map(Number) } : {}),
  }
}

function TimingFields({ kind, Row }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (kind === 'once') {
    return h(Row, { label: '执行时间', hint: `按当前时区（${zone}）执行` },
      h('input', { name: 'when', type: 'datetime-local', className: 'bt-input', 'aria-label': '执行时间', required: true }))
  }
  if (kind === 'interval') {
    return h(Row, { label: '间隔分钟', hint: '每隔指定分钟数自动触发执行' },
      h('input', { name: 'minutes', type: 'number', min: 1, defaultValue: 60, className: 'bt-input', 'aria-label': '间隔分钟', required: true }))
  }
  if (kind === 'rrule') {
    return [
      h('div', { key: 'rrule', className: 'bt-set-row bt-set-paste' },
        h('div', { className: 'bt-set-copy' },
          h('span', null, 'RRULE 规则'),
          h('span', { className: 'bt-set-hint' }, '标准 iCalendar 递归调度规则定义')),
        h('textarea', {
          name: 'rrule', rows: 2, className: 'bt-input bt-input-area',
          'aria-label': 'RRULE', placeholder: 'DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=1MO', required: true,
        })),
      h(Row, { key: 'tz', label: 'IANA 时区', hint: '定时调度参考的时区名称' },
        h('input', { name: 'timeZone', className: 'bt-input', defaultValue: zone, 'aria-label': 'IANA 时区', required: true })),
    ]
  }
  return [
    kind === 'cron'
      ? h(Row, { key: 'cron', label: '五字段 Cron', hint: '分 时 日 月 周，例如 0 9 * * 1-5' },
          h('input', { name: 'expression', className: 'bt-input', placeholder: '0 9 * * 1-5', 'aria-label': '五字段 Cron', required: true }))
      : h(Row, { key: 'time', label: '本地时间', hint: '每天固定触发时间（HH:MM）' },
          h('input', { name: 'time', type: 'time', className: 'bt-input', defaultValue: '09:00', 'aria-label': '本地时间', required: true })),
    kind === 'weekly' && h(Row, { key: 'days', label: '执行日', hint: '选择每周几执行' },
      h('div', { className: 'bt-browser-action-list' },
        days.map((day, index) => h('label', { key: day, className: 'bt-browser-action-choice' },
          h('input', { type: 'checkbox', name: 'day', value: index + 1, defaultChecked: index < 5 }),
          day)))),
    h(Row, { key: 'tz', label: 'IANA 时区', hint: '定时调度参考的时区名称' },
      h('input', { name: 'timeZone', className: 'bt-input', defaultValue: zone, 'aria-label': 'IANA 时区', required: true })),
  ]
}

export function AutomationSetupPage({ client, roster, actions, initial, Section: CustomSection, Row: CustomRow }) {
  const Section = CustomSection ?? DefaultSection
  const Row = CustomRow ?? DefaultRow
  const [catalog, setCatalog] = useState()
  const [type, setType] = useState(initial?.kind ?? 'message')
  const [trigger, setTrigger] = useState('schedule')
  const [kind, setKind] = useState('once')
  const [error, setError] = useState('')
  const [result, setResult] = useState()
  const inFlight = useRef(false)
  const last = useRef()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (initial?.kind) setType(initial.kind)
  }, [initial?.kind])

  useEffect(() => {
    let disposed = false
    client.dispatch({ action: 'automation.setup.view' }).then(
      value => { if (!disposed) setCatalog(value) },
      failure => { if (!disposed) setError(failure.message) },
    )
    return () => { disposed = true }
  }, [client])

  async function submit(event) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setResult(undefined)
    try {
      const form = new FormData(event.currentTarget)
      const input = {
        title: form.get('title'), instructions: form.get('instructions'), checkOnly: form.get('executionMode') === 'check',
        target: { kind: type, id: form.get('target') },
        trigger: {
          kind: trigger,
          ...(trigger === 'schedule' ? { when: timing(form, kind) }
            : trigger === 'github' ? { repo: form.get('repo'), eventType: form.get('eventType') } : {}),
        },
      }
      if (type === 'workflow') input.target.revision = catalog.workflows.find(item => item.id === input.target.id)?.revision
      const signature = JSON.stringify(input)
      if (last.current?.signature !== signature) last.current = { signature, id: crypto.randomUUID() }
      setResult(await client.dispatch({ action: 'automation.setup.create', requestId: last.current.id, ...input }))
    } catch (failure) {
      setError(failure.message)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const choices = type === 'workflow' ? catalog?.workflows.map(item => ({ ...item, name: item.name + ' · R' + item.revision })) ?? []
    : [...roster.bots, ...(type === 'message' ? roster.rooms : [])]
  const available = catalog && (type !== 'message' || catalog.available)

  return h('div', { className: 'bt-settings-form' },
    error && h('div', { role: 'alert', className: 'bt-error' }, error),
    h('form', { className: 'bt-automation-form', onSubmit: submit, 'aria-label': '统一创建自动化' },
      h('fieldset', { disabled: busy || Boolean(roster.readOnly), style: { border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '18px' } },
        h(Section, { title: '执行目标' },
          h(Row, { label: '执行方式', hint: '选择由 Bot 在会话中执行、创建派工任务，还是执行工作流' },
            h('select', {
              className: 'bt-select', 'aria-label': '执行方式', value: type,
              onChange: event => {
                const next = event.target.value
                if (next === 'message') setTrigger('schedule')
                if (next !== 'message' && ['cron', 'rrule'].includes(kind)) setKind('once')
                setType(next)
              },
            }, targets.map(([value, label]) => h('option', { key: value, value }, label)))),
          h(Row, {
            label: '执行对象',
            hint: type === 'workflow' ? '选择要运行的工作流定义版本' : type === 'task' ? '选择负责执行任务的 Bot' : '选择接收执行指令的目标会话',
          },
          h('select', {
            key: type, name: 'target', className: 'bt-select', 'aria-label': '执行对象',
            defaultValue: initial?.id ?? '', required: true,
          },
          h('option', { value: '' }, '选择' + (type === 'workflow' ? '工作流版本' : type === 'task' ? ' Bot' : '会话')),
          choices.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h(Row, { label: '任务名称', hint: '设置简短清晰的自动化任务标题（最多 120 字）' },
            h('input', {
              name: 'title', className: 'bt-input', 'aria-label': '任务名称',
              required: true, maxLength: 120, placeholder: '例如：每日项目状态同步',
            })),
          type !== 'workflow' && h('div', { className: 'bt-set-row bt-set-paste' },
            h('div', { className: 'bt-set-copy' },
              h('span', null, type === 'message' ? '执行指令' : '执行要求与验收条件'),
              h('span', { className: 'bt-set-hint' }, type === 'message' ? '向目标会话发送给 Bot 的具体执行提示词' : '明确任务的目标要求、输出格式和验收标准')),
            h('textarea', {
              name: 'instructions', className: 'bt-input bt-input-area',
              'aria-label': type === 'message' ? '执行指令' : '执行要求与验收条件',
              required: true, rows: 3, maxLength: 16_000,
              placeholder: type === 'message' ? '输入要发送到会话的提示词或指令…' : '描述执行目标与验收证据要求…',
            }))),
        h(Section, { title: '触发规则' },
          h(Row, { label: '何时开始', hint: '支持按定时日程、外部 Webhook 或 GitHub 仓库事件自动触发' },
            h('select', {
              className: 'bt-select', 'aria-label': '何时开始', value: trigger,
              onChange: event => setTrigger(event.target.value),
            },
            h('option', { value: 'schedule' }, '按日程'),
            type !== 'message' && h('option', { value: 'webhook' }, '收到 Webhook'),
            type !== 'message' && h('option', { value: 'github' }, 'GitHub 公开仓库事件'))),
          trigger === 'schedule' && h(Row, { label: '重复方式', hint: '设置单次执行或周期性重复调度规则' },
            h('select', {
              className: 'bt-select', 'aria-label': '重复方式', value: kind,
              onChange: event => setKind(event.target.value),
            },
            [...sharedTimings, ...(type === 'message' ? [['cron', 'Cron 表达式'], ['rrule', 'iCalendar (RRULE)']] : [])].map(([value, label]) =>
              h('option', { key: value, value }, label)))),
          trigger === 'schedule' && h(TimingFields, { key: kind, kind, Row }),
          trigger === 'github' && [
            h(Row, { key: 'repo', label: 'GitHub 仓库', hint: '填入公开仓库完整路径' },
              h('input', { name: 'repo', className: 'bt-input', 'aria-label': 'GitHub 仓库', placeholder: 'owner/repo', required: true })),
            h(Row, { key: 'event', label: '事件类型', hint: '监听特定事件，例如 IssuesEvent；留空监听所有支持的事件' },
              h('input', { name: 'eventType', className: 'bt-input', 'aria-label': '事件类型', placeholder: '例如 IssuesEvent，可留空' })),
          ],
          trigger === 'webhook' && h(Row, { label: 'Webhook 说明', hint: '创建后将生成专用端点 URL 和签名密钥，支持外部系统回调触发' })),
        h(Section, { title: '执行策略' },
          h(Row, { label: '动作权限', hint: '按策略执行允许调用授权工具；只检查并反馈将限制修改外部系统' },
            h('select', { className: 'bt-select', name: 'executionMode', 'aria-label': '动作权限' },
              h('option', { value: 'normal' }, '按 Bot 和工作区策略执行'),
              h('option', { value: 'check' }, '只检查并反馈'))),
          h('div', { className: 'bt-automation-form-foot' },
            catalog && !available
              ? h('span', { role: 'status', className: 'bt-set-hint bt-danger' }, '在 DSH 插件设置启用自动化任务后可调度会话。')
              : h('span', { className: 'bt-set-hint' }, '创建后将立即由调度系统接管运行'),
            h('button', {
              type: 'submit',
              className: 'bt-send bt-soft-sm',
              disabled: busy || !available || !choices.length,
            }, busy ? '正在创建…' : '创建自动化'))))),
    result && h(Section, { title: result.replayed ? '此请求已创建' : '自动化已创建' },
      h(Row, {
        label: result.replayed ? '已恢复已有自动化' : '自动化任务创建成功',
        hint: '可在对应管理页面中查看调度状态、运行记录与执行结果',
      },
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        onClick: () => actions.openSettings(destinations[result.mode][0]),
      }, destinations[result.mode][1])),
      result.url ? h(Row, { label: '投递地址', hint: '外部系统向此 URL 发送 POST 请求' },
        h('code', { className: 'bt-la-path', style: { fontSize: '12px', userSelect: 'all', padding: '4px 8px', borderRadius: '6px', background: 'var(--bt-hover)' } }, result.url)) : null,
      result.secret ? h(Row, { label: '签名密钥', hint: '用于请求签名的校验密钥' },
        h('code', { 'data-sensitive': true, className: 'bt-la-path', style: { fontSize: '12px', userSelect: 'all', padding: '4px 8px', borderRadius: '6px', background: 'var(--bt-hover)' } }, result.secret)) : null),
    h(Section, { title: '相关管理' },
      h('button', { type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('schedules') },
        h('span', { className: 'bt-set-copy' },
          h('span', null, '会话日程'),
          h('span', { className: 'bt-set-hint' }, '管理会话中由 Bot 发送的定时消息')),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
      h('button', { type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('routines') },
        h('span', { className: 'bt-set-copy' },
          h('span', null, '定时派工'),
          h('span', { className: 'bt-set-hint' }, '管理团队成员的自动化派工与定期巡检任务')),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
      h('button', { type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('tasks') },
        h('span', { className: 'bt-set-copy' },
          h('span', null, '事件与工作流'),
          h('span', { className: 'bt-set-hint' }, '查看任务看板、工作流定义与事件触发器')),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))))
}
