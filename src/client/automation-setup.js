import { createElement as h, useEffect, useRef, useState } from 'react'
import { button, field, option, row } from './controls.js'

const destinations = { messages: ['schedules', '查看会话日程'], routines: ['routines', '查看定时派工'], events: ['tasks', '查看事件设置'] }
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const targets = [['message', '在会话执行'], ['task', '派工并验收'], ['workflow', '运行已保存工作流']]
const sharedTimings = [['once', '一次'], ['interval', '固定间隔'], ['daily', '每天'], ['weekly', '每周']]

function timing(form, kind) {
  if (kind === 'once') return { kind, at: new Date(form.get('when')).toISOString() }
  if (kind === 'interval') return { kind, minutes: Number(form.get('minutes')) }
  if (kind === 'cron') return { kind, expression: form.get('expression'), timeZone: form.get('timeZone') }
  if (kind === 'rrule') return { kind, rrule: form.get('rrule') }
  return { kind, time: form.get('time'), timeZone: form.get('timeZone'),
    ...(kind === 'weekly' ? { weekdays: form.getAll('day').map(Number) } : {}) }
}

function TimingFields({ kind }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (kind === 'once') return field('执行时间', h('input', { name: 'when', type: 'datetime-local', required: true }))
  if (kind === 'interval') return field('间隔分钟', h('input', { name: 'minutes', type: 'number', min: 1, defaultValue: 60, required: true }))
  if (kind === 'rrule') return field('RRULE', h('textarea', { name: 'rrule', rows: 2, required: true }))
  return h('div', { className: 'gb-form' },
    kind === 'cron' ? field('五字段 Cron', h('input', { name: 'expression', placeholder: '0 9 * * 1-5', required: true }))
      : field('本地时间', h('input', { name: 'time', type: 'time', defaultValue: '09:00', required: true })),
    field('IANA 时区', h('input', { name: 'timeZone', defaultValue: zone, required: true })),
    kind === 'weekly' && row(...days.map((day, index) => h('label', { key: day },
      h('input', { type: 'checkbox', name: 'day', value: index + 1, defaultChecked: index < 5 }), day))))
}

export function AutomationSetupPage({ client, roster, actions, initial }) {
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
        trigger: { kind: trigger, ...(trigger === 'schedule' ? { when: timing(form, kind) }
          : trigger === 'github' ? { repo: form.get('repo'), eventType: form.get('eventType') } : {}) },
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
  return h('div', { className: 'gb-stack' },
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    h('form', { className: 'gb-card gb-form', onSubmit: submit, 'aria-label': '统一创建自动化' },
      h('fieldset', { disabled: busy || Boolean(roster.readOnly) },
        h('div', { className: 'gb-form' },
          field('执行方式', h('select', { value: type, onChange: event => {
            const next = event.target.value
            if (next === 'message') setTrigger('schedule')
            if (next !== 'message' && ['cron', 'rrule'].includes(kind)) setKind('once')
            setType(next)
          } }, ...targets.map(([value, label]) => option(value, label)))),
          field('执行对象', h('select', { key: type, name: 'target', defaultValue: initial?.id ?? '', required: true },
            option('', '选择' + (type === 'workflow' ? '工作流版本' : type === 'task' ? ' Bot' : '会话')),
            ...choices.map(item => option(item.id, item.name)))),
          field('任务名称', h('input', { name: 'title', required: true, maxLength: 120 })),
          type !== 'workflow' && field(type === 'message' ? '执行指令' : '执行要求与验收条件',
            h('textarea', { name: 'instructions', required: true, rows: 3, maxLength: 16_000 })),
          field('动作权限', h('select', { name: 'executionMode' }, option('normal', '按 Bot 和工作区策略执行'), option('check', '只检查并反馈'))),
          field('何时开始', h('select', { value: trigger, onChange: event => setTrigger(event.target.value) },
            option('schedule', '按日程'), type !== 'message' && option('webhook', '收到 Webhook'),
            type !== 'message' && option('github', 'GitHub 公开仓库事件'))),
          trigger === 'schedule' && field('重复方式', h('select', { value: kind, onChange: event => setKind(event.target.value) },
            ...[...sharedTimings, ...(type === 'message' ? [['cron', 'Cron'], ['rrule', 'RRULE']] : [])].map(([value, label]) => option(value, label)))),
          trigger === 'schedule' && h(TimingFields, { key: kind, kind }),
          trigger === 'github' && field('GitHub 仓库', h('input', { name: 'repo', placeholder: 'owner/repo', required: true })),
          trigger === 'github' && field('事件类型', h('input', { name: 'eventType', placeholder: '例如 IssuesEvent，可留空' })),
          catalog && !available && h('p', { role: 'status', className: 'gb-muted' }, '在 DSH 插件设置启用自动化任务后可调度会话。'),
          h('button', { type: 'submit', className: 'gb-primary', disabled: busy || !available || !choices.length }, busy ? '正在创建…' : '创建自动化')))),
    result && h('div', { className: 'gb-card', role: 'status' },
      h('p', null, result.replayed ? '此请求已创建' : '自动化已创建'),
      result.url && h('p', null, '投递地址 ', h('code', null, result.url)),
      result.secret && h('p', { 'data-sensitive': true }, '签名密钥 ', h('code', null, result.secret)),
      button(destinations[result.mode][1], () => actions.openSettings(destinations[result.mode][0]))),
    row(button('会话日程', () => actions.openSettings('schedules')),
      button('定时派工', () => actions.openSettings('routines')), button('事件与工作流', () => actions.openSettings('tasks'))))
}
