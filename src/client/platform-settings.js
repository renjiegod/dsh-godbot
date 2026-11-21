import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { button, field, option, row, stamp } from './controls.js'
import { ViewCard } from './team-ui/widget-cell.js'

const sourceLabels = {
  person: '人工', schedule: '日程', workflow: '人工启动工作流', ci: 'CI', webhook: 'Webhook',
  github: 'GitHub', handoff: 'Bot 转派', service: '后台服务', unknown: '待确认',
  unattended: '无人值守', any: '全部来源',
}

function useSettingsData(client, prefix, initial = 'list') {
  const [data, setData] = useState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const writing = useRef(false)
  const send = useCallback((verb, fields) => client.dispatch({ action: prefix + '.' + verb, ...fields }), [client, prefix])
  useEffect(() => {
    let disposed = false
    send(initial).then(value => { if (!disposed) setData(value) }, failure => { if (!disposed) setError(failure.message) })
    return () => { disposed = true }
  }, [send, initial])
  async function perform(verb, fields, apply) {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    setError('')
    try {
      const result = await send(verb, fields)
      if (apply) apply(result, setData)
      else setData(result)
    } catch (failure) {
      setError(failure.message)
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  return { busy, error, data, perform, setError }
}

const componentExample = {
  title: '交付确认',
  parameters: { summary: 'string' },
  functions: ['bot-status'],
  view: { type: 'stack', children: [
    { type: 'text', text: '{{bot_name}} 提交了交付结果' },
    { type: 'callout', text: '{{summary}}' },
    { type: 'confirm', id: 'check-deliverable', confirmLabel: '确认', cancelLabel: '要求修改' },
  ] },
}
const toJson = value => JSON.stringify(value, null, 2)

export function ComponentSettings({ client, roster }) {
  const { data, busy, error, setError, perform } = useSettingsData(client, 'components')
  const [name, setName] = useState('')
  const [definition, setDefinition] = useState(() => toJson(componentExample))
  const [preview, setPreview] = useState()
  const selected = data?.components.find(component => component.name === name)
  const locked = Boolean(roster.readOnly) || busy || !data
  function definitionRequest(verb) {
    try {
      const template = JSON.parse(definition)
      if (verb === 'preview') void perform(verb, { template }, setPreview)
      else void perform(verb, { name, template })
    } catch {
      setError('组件定义须为有效 JSON')
    }
  }
  return h('div', { className: 'gb-stack' },
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    data && field('选择组件', h('select', { value: selected ? name : '', onChange: event => {
      const component = data.components.find(item => item.name === event.target.value)
      setName(component?.name ?? '')
      setDefinition(toJson(component?.draft ?? componentExample))
      setPreview(undefined)
    } }, option('', '新建组件'), ...data.components.map(item => option(item.name, item.name + (item.published ? ' · v' + item.published.version : ' · 草稿'))))),
    h('form', { className: 'gb-form gb-card', onSubmit: event => { event.preventDefault(); definitionRequest('save') } },
      field('组件名称', h('input', { value: name, onChange: event => setName(event.target.value), required: true, pattern: '[a-z][a-z0-9-]*', maxLength: 40 })),
      field('组件定义', h('textarea', { rows: 15, value: definition, onChange: event => { setDefinition(event.target.value); setPreview(undefined) }, spellCheck: false })),
      row(button('预览定义', () => definitionRequest('preview'), { disabled: locked }),
        h('button', { type: 'submit', className: 'gb-primary', disabled: locked }, '保存草稿')),
      preview && h(ViewCard, { title: preview.title, view: preview.view, busy: true })),
    selected && h('div', { className: 'gb-card gb-form' },
      h('p', { role: 'status' }, selected.published ? '已发布 v' + selected.published.version : '草稿待发布'),
      row(button('发布已保存草稿', () => perform('publish', { name }), { disabled: locked }),
        selected.published && button('下架组件', () => perform('unpublish', { name }), { disabled: locked })),
      h('form', { key: toJson([name, selected.bots, selected.allowedFunctions]), className: 'gb-form', onSubmit: event => {
        event.preventDefault()
        const input = new FormData(event.currentTarget)
        void perform('grants', { name, bots: input.getAll('bot'), functions: input.getAll('function') })
      } },
      h('fieldset', { className: 'gb-form', disabled: locked },
        h('legend', null, '允许使用的 Bot 和数据函数'),
        ...roster.bots.map(bot => h('label', { key: bot.id }, h('input', { type: 'checkbox', name: 'bot', value: bot.id, defaultChecked: selected.bots.includes(bot.id) }), bot.name)),
        ...data.functions.map(item => h('label', { key: item.id },
          h('input', { type: 'checkbox', name: 'function', value: item.id, defaultChecked: selected.allowedFunctions.includes(item.id) }),
          item.title + ' · ' + Object.keys(item.slots).map(key => '{{' + key + '}}').join('、'))),
        h('button', { type: 'submit' }, '保存授权')))))
}

const blankRule = { name: '', origin: 'unattended', tool: 'changes', effect: 'ask', enabled: true }
const decisionNames = { allow: '继续现有权限检查', ask: '需要批准', deny: '拒绝' }

function sourceSelect(name, allowed, initial) {
  return h('select', { name, defaultValue: initial }, ...allowed.map(value => option(value, sourceLabels[value] ?? (value || '全部来源'))))
}

function botSelect(bots, name, initial, empty) {
  return h('select', { name, defaultValue: initial ?? '' }, option('', empty), ...bots.map(bot => option(bot.id, bot.name)))
}

function downloadAudit(data) {
  const url = URL.createObjectURL(new Blob([toJson(data)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'godbot-execution-audit.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function GovernanceSettings({ client, roster }) {
  const { data, error, busy, perform } = useSettingsData(client, 'governance', 'view')
  const [selected, setSelected] = useState()
  const [preview, setPreview] = useState()
  const [filter, setFilter] = useState({})
  const current = data?.rules.find(rule => rule.id === selected) ?? blankRule
  const origins = data?.origins ?? []
  const locked = Boolean(roster.readOnly) || busy || !data
  return h('div', { className: 'gb-stack' },
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    data && field('规则', h('select', { value: selected ?? '', onChange: event => setSelected(event.target.value || undefined) },
      option('', '新建规则'), ...data.rules.map(rule => option(rule.id, rule.name + (rule.enabled ? '' : ' · 已停用'))))),
    h('form', { key: toJson(current), className: 'gb-form gb-card', onSubmit: event => {
      event.preventDefault()
      const supplied = new FormData(event.currentTarget)
      void perform('save', { id: selected, rule: { ...Object.fromEntries(supplied), enabled: supplied.has('enabled') } })
    } },
    h('fieldset', { disabled: locked, className: 'gb-form' },
      field('规则名称', h('input', { name: 'name', defaultValue: current.name, required: true, maxLength: 100 })),
      field('发起来源', sourceSelect('origin', ['any', 'unattended', ...origins], current.origin)),
      field('应用于 Bot', botSelect(roster.bots, 'botId', current.botId, '全部 Bot')),
      field('工具', h('input', { name: 'tool', defaultValue: current.tool, placeholder: 'changes、* 或工具名称', required: true })),
      field('目标', h('input', { name: 'target', defaultValue: current.target, placeholder: '可选，例如 https://example.com' })),
      field('决定', h('select', { name: 'effect', defaultValue: current.effect }, option('ask', '要求批准'), option('deny', '禁止'))),
      h('label', null, h('input', { type: 'checkbox', name: 'enabled', defaultChecked: current.enabled }), '启用'),
      row(h('button', { className: 'gb-primary', type: 'submit' }, '保存规则'),
        selected && button('删除规则', () => perform('remove', { id: selected }, (value, update) => {
          setSelected(undefined)
          update(value)
        }))))),
    h('form', { className: 'gb-form gb-card', onSubmit: event => {
      event.preventDefault()
      void perform('preview', Object.fromEntries(new FormData(event.currentTarget)), setPreview)
    } },
    h('h3', null, '预览规则结果'),
    field('发起来源', sourceSelect('origin', origins, 'schedule')),
    field('Bot', botSelect(roster.bots, 'botId', '', '请选择 Bot')),
    field('工具名称', h('input', { name: 'tool', defaultValue: 'browser_click', required: true })),
    field('目标', h('input', { name: 'target', placeholder: '可选' })),
    h('button', { type: 'submit', disabled: busy || !data }, '查看匹配'),
    preview && h('p', { role: 'status' }, decisionNames[preview.decision] + (preview.reason ? ' · ' + preview.reason : ''))),
    h('section', { className: 'gb-card gb-stack' },
      h('h3', null, '执行审计'),
      h('form', { className: 'gb-form', onSubmit: event => {
        event.preventDefault()
        const next = Object.fromEntries(new FormData(event.currentTarget))
        setFilter(next)
        void perform('view', next)
      } },
      field('来源', sourceSelect('origin', ['', 'unattended', ...origins], '')),
      field('决定', h('select', { name: 'decision' }, option('', '全部决定'), ...Object.entries(decisionNames).map(([value, label]) => option(value, label)))),
      field('Bot', botSelect(roster.bots, 'botId', '', '全部 Bot')),
      row(h('button', { type: 'submit', disabled: busy }, '筛选和刷新'),
        button('导出审计 JSON', () => perform('export', filter, downloadAudit), { disabled: busy }))),
      (data?.audit ?? []).map(entry => h('p', { key: entry.id },
        stamp(entry.time) + ' · ' + (roster.byId[entry.botId]?.name ?? entry.botId) + ' · ' +
        (sourceLabels[entry.origin.kind] ?? entry.origin.kind) + ' · ' + entry.name + ' · ' + (entry.effect ?? decisionNames[entry.decision]) +
        (entry.reason ? ' · ' + entry.reason : '')))))
}

export function RemoteAgentSettings({ client, roster, actions }) {
  const { data, busy, error, perform } = useSettingsData(client, 'remote-agents')
  const [selected, setSelected] = useState('')
  const item = data?.agents.find(agent => agent.id === selected)
  const locked = Boolean(roster.readOnly) || busy || !data
  return h('div', { className: 'gb-stack' },
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    data && field('远程 Agent', h('select', { value: selected, onChange: event => setSelected(event.target.value) },
      option('', '注册远程 Agent'), ...data.agents.map(agent => option(agent.id, agent.name)))),
    h('form', { key: toJson(item), className: 'gb-form gb-card', onSubmit: event => {
      event.preventDefault()
      const element = event.currentTarget
      const form = new FormData(element)
      const token = form.get('token').trim()
      const input = { id: item?.id, name: form.get('name'), endpoint: form.get('endpoint'),
        ...(form.has('clear') ? { token: '' } : token ? { token } : {}) }
      void perform('save', input, (value, update) => {
        setSelected(item?.id ?? value.agents.at(-1)?.id ?? '')
        element.reset()
        update(value)
      })
    } },
    h('fieldset', { className: 'gb-form', disabled: locked },
      field('名称', h('input', { name: 'name', defaultValue: item?.name, required: true, maxLength: 100 })),
      field('AG-UI 运行地址', h('input', { name: 'endpoint', type: 'url', defaultValue: item?.endpoint, required: true, placeholder: 'https://agent.example.com/ag-ui' })),
      field('Bearer 凭据', h('input', { name: 'token', type: 'password', autoComplete: 'off', placeholder: item?.usesToken ? '已配置，留空保留' : '可选' })),
      item?.usesToken && h('label', null, h('input', { name: 'clear', type: 'checkbox' }), '清除已有凭据'),
      row(h('button', { type: 'submit', className: 'gb-primary' }, item ? '保存' : '注册'),
        item && button('移除', () => perform('remove', { id: item.id }, (value, update) => { setSelected(''); update(value) }))))),
    item && h('p', null, '在 Bot 的模型设置中选择 ', item.name, '。', button('打开 Bot 设置', () => actions.openSettings('bots'))))
}
