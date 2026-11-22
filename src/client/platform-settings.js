import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { stamp } from './controls.js'
import { ViewCard } from './team-ui/widget-cell.js'

const sourceLabels = {
  person: '人工', schedule: '日程', workflow: '人工启动工作流', ci: 'CI', webhook: 'Webhook',
  github: 'GitHub', handoff: 'Bot 转派', service: '后台服务', unknown: '待确认',
  unattended: '无人值守', any: '全部来源',
}

const DefaultSection = ({ title, action = null, className = '', children }) =>
  h('section', { className: `bt-set-section ${className}`.trim() },
    action ? h('div', { className: 'bt-la-sec-head' }, h('h3', null, title), action) : title ? h('h3', null, title) : null,
    h('div', { className: 'bt-set-card' }, children))

const DefaultRow = ({ label, hint, children, className = '' }) =>
  h('div', { className: `bt-set-row ${className}`.trim() },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: 'bt-set-control' }, children) : null)

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

export function ComponentSettings({ client, roster, Section: CustomSection, Row: CustomRow }) {
  const Section = CustomSection ?? DefaultSection
  const Row = CustomRow ?? DefaultRow
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

  return h('div', { className: 'bt-settings-form' },
    error && h('p', { role: 'alert', className: 'bt-danger', style: { margin: '0 0 12px' } }, error),
    data && h(Section, { title: '业务组件' },
      h(Row, { label: '选择组件', hint: '选择已有组件修改，或创建新组件' },
        h('select', {
          className: 'bt-select',
          'aria-label': '选择组件',
          value: selected ? name : '',
          onChange: event => {
            const component = data.components.find(item => item.name === event.target.value)
            setName(component?.name ?? '')
            setDefinition(toJson(component?.draft ?? componentExample))
            setPreview(undefined)
          },
        },
        h('option', { value: '' }, '新建组件'),
        ...data.components.map(item => h('option', { key: item.name, value: item.name }, item.name + (item.published ? ' · v' + item.published.version : ' · 草稿')))))),
    h('form', {
      className: 'bt-automation-form',
      onSubmit: event => { event.preventDefault(); definitionRequest('save') },
    },
    h(Section, { title: selected ? '编辑组件定义' : '新建组件定义' },
      h(Row, { label: '组件名称', hint: '小写字母开头，支持小写字母、数字与连字符' },
        h('input', {
          className: 'bt-input',
          'aria-label': '组件名称',
          value: name,
          onChange: event => setName(event.target.value),
          required: true,
          pattern: '[a-z][a-z0-9-]*',
          maxLength: 40,
        })),
      h('div', { className: 'bt-set-row bt-set-paste' },
        h('div', { className: 'bt-set-copy' },
          h('span', null, '组件定义'),
          h('span', { className: 'bt-set-hint' }, 'JSON 格式的组件视图与参数定义')),
        h('textarea', {
          rows: 12,
          className: 'bt-input bt-input-area',
          'aria-label': '组件定义',
          value: definition,
          onChange: event => { setDefinition(event.target.value); setPreview(undefined) },
          spellCheck: false,
        })),
      h('div', { className: 'bt-automation-form-foot' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: locked, onClick: () => definitionRequest('preview') }, '预览定义'),
        h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: locked }, '保存草稿')),
      preview && h('div', { style: { padding: '12px 16px', borderTop: '0.5px solid var(--bt-line)' } },
        h(ViewCard, { title: preview.title, view: preview.view, busy: true })))),
    selected && h(Section, { title: '发布与授权' },
      h(Row, { label: '发布状态', hint: '只有已发布的组件版本可在会话或工作流中被渲染' },
        h('span', { role: 'status', className: 'bt-set-hint', style: { fontWeight: 600 } },
          selected.published ? '已发布 v' + selected.published.version : '草稿待发布')),
      h('div', { className: 'bt-automation-form-foot' },
        h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: locked, onClick: () => perform('publish', { name }) }, '发布已保存草稿'),
        selected.published && h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-danger', disabled: locked, onClick: () => perform('unpublish', { name }) }, '下架组件')),
      h('form', {
        key: toJson([name, selected.bots, selected.allowedFunctions]),
        className: 'bt-automation-form',
        onSubmit: event => {
          event.preventDefault()
          const input = new FormData(event.currentTarget)
          void perform('grants', { name, bots: input.getAll('bot'), functions: input.getAll('function') })
        },
      },
      h('fieldset', { disabled: locked, style: { border: 0, padding: 0, margin: 0, display: 'contents' } },
        h(Row, { label: '允许使用的 Bot', hint: '勾选允许调用此组件渲染卡片的 Bot' },
          h('div', { className: 'bt-browser-action-list' },
            roster.bots.map(bot => h('label', { key: bot.id, className: 'bt-browser-action-choice' },
              h('input', { type: 'checkbox', name: 'bot', value: bot.id, defaultChecked: selected.bots.includes(bot.id) }),
              bot.name)))),
        h(Row, { label: '数据函数授权', hint: '允许此组件执行插槽替换的数据函数' },
          h('div', { className: 'bt-browser-action-list' },
            data.functions.map(item => h('label', { key: item.id, className: 'bt-browser-action-choice' },
              h('input', { type: 'checkbox', name: 'function', value: item.id, defaultChecked: selected.allowedFunctions.includes(item.id) }),
              item.title + ' · ' + Object.keys(item.slots).map(key => '{{' + key + '}}').join('、'))))),
        h('div', { className: 'bt-automation-form-foot' },
          h('button', { type: 'submit', className: 'bt-send bt-soft-sm' }, '保存授权'))))))
}

const blankRule = { name: '', origin: 'unattended', tool: 'changes', effect: 'ask', enabled: true }
const decisionNames = { allow: '继续现有权限检查', ask: '需要批准', deny: '拒绝' }

function sourceSelect(name, allowed, initial, ariaLabel) {
  return h('select', { name, className: 'bt-select', 'aria-label': ariaLabel, defaultValue: initial },
    ...allowed.map(value => h('option', { key: value, value }, sourceLabels[value] ?? (value || '全部来源'))))
}

function botSelect(bots, name, initial, empty, ariaLabel) {
  return h('select', { name, className: 'bt-select', 'aria-label': ariaLabel, defaultValue: initial ?? '' },
    h('option', { value: '' }, empty), ...bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))
}

function downloadAudit(data) {
  const url = URL.createObjectURL(new Blob([toJson(data)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'godbot-execution-audit.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function GovernanceSettings({ client, roster, Section: CustomSection, Row: CustomRow }) {
  const Section = CustomSection ?? DefaultSection
  const Row = CustomRow ?? DefaultRow
  const { data, error, busy, perform } = useSettingsData(client, 'governance', 'view')
  const [selected, setSelected] = useState()
  const [preview, setPreview] = useState()
  const [filter, setFilter] = useState({})
  const current = data?.rules.find(rule => rule.id === selected) ?? blankRule
  const origins = data?.origins ?? []
  const locked = Boolean(roster.readOnly) || busy || !data

  return h('div', { className: 'bt-settings-form' },
    error && h('p', { role: 'alert', className: 'bt-danger', style: { margin: '0 0 12px' } }, error),
    data && h(Section, { title: '执行策略规则' },
      h(Row, { label: '选择规则', hint: '选择已有规则修改或创建新规则' },
        h('select', {
          className: 'bt-select',
          'aria-label': '规则',
          value: selected ?? '',
          onChange: event => setSelected(event.target.value || undefined),
        },
        h('option', { value: '' }, '新建规则'),
        ...data.rules.map(rule => h('option', { key: rule.id, value: rule.id }, rule.name + (rule.enabled ? '' : ' · 已停用')))))),
    h('form', {
      key: toJson(current),
      className: 'bt-automation-form',
      onSubmit: event => {
        event.preventDefault()
        const supplied = new FormData(event.currentTarget)
        void perform('save', { id: selected, rule: { ...Object.fromEntries(supplied), enabled: supplied.has('enabled') } })
      },
    },
    h(Section, { title: selected ? '编辑规则' : '新建规则' },
      h('fieldset', { disabled: locked, style: { border: 0, padding: 0, margin: 0, display: 'contents' } },
        h(Row, { label: '规则名称', hint: '便于识别该拦截或放行策略的名称' },
          h('input', {
            name: 'name',
            className: 'bt-input',
            'aria-label': '规则名称',
            defaultValue: current.name,
            required: true,
            maxLength: 100,
          })),
        h(Row, { label: '发起来源', hint: '限制触发调用的来源环境' },
          sourceSelect('origin', ['any', 'unattended', ...origins], current.origin, '发起来源')),
        h(Row, { label: '应用于 Bot', hint: '限制此规则生效的特定 Bot，留空应用于全部 Bot' },
          botSelect(roster.bots, 'botId', current.botId, '全部 Bot', '应用于 Bot')),
        h(Row, { label: '工具', hint: '匹配的工具名称，例如 remember、changes 或 *' },
          h('input', {
            name: 'tool',
            className: 'bt-input',
            'aria-label': '工具',
            defaultValue: current.tool,
            placeholder: 'changes、* 或工具名称',
            required: true,
          })),
        h(Row, { label: '目标', hint: '匹配调用的目标，如网址或对象标识（可选）' },
          h('input', {
            name: 'target',
            className: 'bt-input',
            'aria-label': '目标',
            defaultValue: current.target,
            placeholder: '可选，例如 https://example.com',
          })),
        h(Row, { label: '决定', hint: '命中规则时的执行动作' },
          h('select', {
            name: 'effect',
            className: 'bt-select',
            'aria-label': '决定',
            defaultValue: current.effect,
          },
          h('option', { value: 'ask' }, '要求批准'),
          h('option', { value: 'deny' }, '禁止'))),
        h(Row, { label: '规则状态', hint: '启用或停用此条规则' },
          h('label', { className: 'bt-browser-action-choice' },
            h('input', { type: 'checkbox', name: 'enabled', defaultChecked: current.enabled }),
            '启用')),
        h('div', { className: 'bt-automation-form-foot' },
          h('button', { type: 'submit', className: 'bt-send bt-soft-sm' }, '保存规则'),
          selected && h('button', {
            type: 'button',
            className: 'bt-soft bt-soft-sm bt-danger',
            onClick: () => perform('remove', { id: selected }, (value, update) => {
              setSelected(undefined)
              update(value)
            }),
          }, '删除规则'))))),
    h('form', {
      className: 'bt-automation-form',
      onSubmit: event => {
        event.preventDefault()
        void perform('preview', Object.fromEntries(new FormData(event.currentTarget)), setPreview)
      },
    },
    h(Section, { title: '预览规则结果' },
      h(Row, { label: '发起来源' },
        sourceSelect('origin', origins, 'schedule', '预览发起来源')),
      h(Row, { label: 'Bot' },
        botSelect(roster.bots, 'botId', '', '请选择 Bot', '预览 Bot')),
      h(Row, { label: '工具名称' },
        h('input', { name: 'tool', className: 'bt-input', 'aria-label': '工具名称', defaultValue: 'browser_click', required: true })),
      h(Row, { label: '目标' },
        h('input', { name: 'target', className: 'bt-input', 'aria-label': '预览目标', placeholder: '可选' })),
      h('div', { className: 'bt-automation-form-foot' },
        h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy || !data }, '查看匹配'),
        preview && h('p', { role: 'status', className: 'bt-set-hint', style: { fontWeight: 600 } },
          decisionNames[preview.decision] + (preview.reason ? ' · ' + preview.reason : ''))))),
    h(Section, { title: '执行审计' },
      h('form', {
        className: 'bt-automation-form',
        onSubmit: event => {
          event.preventDefault()
          const next = Object.fromEntries(new FormData(event.currentTarget))
          setFilter(next)
          void perform('view', next)
        },
      },
      h(Row, { label: '来源' },
        sourceSelect('origin', ['', 'unattended', ...origins], '', '审计来源')),
      h(Row, { label: '决定' },
        h('select', { name: 'decision', className: 'bt-select', 'aria-label': '审计决定' },
          h('option', { value: '' }, '全部决定'),
          ...Object.entries(decisionNames).map(([value, label]) => h('option', { key: value, value }, label)))),
      h(Row, { label: 'Bot' },
        botSelect(roster.bots, 'botId', '', '全部 Bot', '审计 Bot')),
      h('div', { className: 'bt-automation-form-foot' },
        h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy }, '筛选和刷新'),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => perform('export', filter, downloadAudit) }, '导出审计 JSON'))),
      (data?.audit ?? []).length > 0
        ? h('div', { style: { padding: '8px 16px', display: 'grid', gap: '8px', borderTop: '0.5px solid var(--bt-line)' } },
            data.audit.map(entry => h('p', { key: entry.id, className: 'bt-set-hint', style: { margin: 0, fontSize: '12px' } },
              stamp(entry.time) + ' · ' + (roster.byId[entry.botId]?.name ?? entry.botId) + ' · ' +
              (sourceLabels[entry.origin.kind] ?? entry.origin.kind) + ' · ' + entry.name + ' · ' + (entry.effect ?? decisionNames[entry.decision]) +
              (entry.reason ? ' · ' + entry.reason : ''))))
        : h('p', { className: 'bt-set-hint', style: { padding: '12px 16px', margin: 0 } }, '暂无审计记录')))
}

export function RemoteAgentSettings({ client, roster, actions, Section: CustomSection, Row: CustomRow }) {
  const Section = CustomSection ?? DefaultSection
  const Row = CustomRow ?? DefaultRow
  const { data, busy, error, perform } = useSettingsData(client, 'remote-agents')
  const [selected, setSelected] = useState('')
  const item = data?.agents.find(agent => agent.id === selected)
  const locked = Boolean(roster.readOnly) || busy || !data

  return h('div', { className: 'bt-settings-form' },
    error && h('p', { role: 'alert', className: 'bt-danger', style: { margin: '0 0 12px' } }, error),
    data && h(Section, { title: '远程 Agent 列表' },
      h(Row, { label: '选择 Agent', hint: '选择已有 Agent 进行配置，或注册新 Agent' },
        h('select', {
          className: 'bt-select',
          'aria-label': '远程 Agent',
          value: selected,
          onChange: event => setSelected(event.target.value),
        },
        h('option', { value: '' }, '注册远程 Agent'),
        ...data.agents.map(agent => h('option', { key: agent.id, value: agent.id }, agent.name))))),
    h('form', {
      key: toJson(item),
      className: 'bt-automation-form',
      onSubmit: event => {
        event.preventDefault()
        const element = event.currentTarget
        const form = new FormData(element)
        const token = form.get('token').trim()
        const input = {
          id: item?.id,
          name: form.get('name'),
          endpoint: form.get('endpoint'),
          ...(form.has('clear') ? { token: '' } : token ? { token } : {}),
        }
        void perform('save', input, (value, update) => {
          setSelected(item?.id ?? value.agents.at(-1)?.id ?? '')
          element.reset()
          update(value)
        })
      },
    },
    h(Section, { title: item ? '编辑远程 Agent' : '注册远程 Agent' },
      h('fieldset', { disabled: locked, style: { border: 0, padding: 0, margin: 0, display: 'contents' } },
        h(Row, { label: '名称', hint: '设置该远程 Agent 在团队中展示的名称' },
          h('input', {
            name: 'name',
            className: 'bt-input',
            'aria-label': '名称',
            defaultValue: item?.name,
            required: true,
            maxLength: 100,
          })),
        h(Row, { label: 'AG-UI 运行地址', hint: '兼容 AG-UI 协议的服务端点 URL' },
          h('input', {
            name: 'endpoint',
            type: 'url',
            className: 'bt-input',
            'aria-label': 'AG-UI 运行地址',
            defaultValue: item?.endpoint,
            required: true,
            placeholder: 'https://agent.example.com/ag-ui',
          })),
        h(Row, { label: 'Bearer 凭据', hint: item?.usesToken ? '已配置凭据，留空则保留' : '访问该端点所需的 Authorization Bearer Token（可选）' },
          h('input', {
            name: 'token',
            type: 'password',
            className: 'bt-input',
            'aria-label': 'Bearer 凭据',
            autoComplete: 'off',
            placeholder: item?.usesToken ? '已配置，留空保留' : '可选',
          })),
        item?.usesToken && h(Row, { label: '清除凭据', hint: '保存时清除已有凭据' },
          h('label', { className: 'bt-browser-action-choice' },
            h('input', { name: 'clear', type: 'checkbox' }),
            '清除已有凭据')),
        h('div', { className: 'bt-automation-form-foot' },
          h('button', { type: 'submit', className: 'bt-send bt-soft-sm' }, item ? '保存' : '注册'),
          item && h('button', {
            type: 'button',
            className: 'bt-soft bt-soft-sm bt-danger',
            onClick: () => perform('remove', { id: item.id }, (value, update) => { setSelected(''); update(value) }),
          }, '移除'))))),
    item && h(Section, { title: '使用引导' },
      h(Row, { label: '在 Bot 中启用', hint: `在 Bot 的模型设置中选择「${item.name}」` },
        h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          onClick: () => actions.openSettings('bots'),
        }, '打开 Bot 设置'))))
}
