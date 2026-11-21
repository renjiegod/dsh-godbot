import { checkShownView } from 'deep-view/core'

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const SLOT = /^[a-z][a-z0-9_]{0,39}$/
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g
const FIELDS = new Set(['text', 'label', 'value', 'caption', 'percent', 'valueLabel', 'placeholder'])
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = value => typeof value === 'boolean' || Number.isFinite(value) || typeof value === 'string' && value.length <= 600
const sampleValues = { string: '示例', number: 0, boolean: false }

const DATA = {
  'bot-status': {
    title: '当前 Bot 状态',
    slots: { bot_name: 'string', bot_model: 'string' },
    read: (_rt, bot) => ({ bot_name: bot.name, bot_model: bot.model ?? '默认模型' }),
  },
  'assigned-work': {
    title: '当前 Bot 的派工数量',
    slots: { assigned_work: 'number' },
    read: (rt, bot) => ({
      assigned_work: Object.values(rt.state.works ?? {}).filter(work => work.botId === bot.id || work.toId === bot.id).length,
    }),
  },
}

function rendered(value, variables, key, depth = 0) {
  if (depth > 20) throw new Error('组件定义的嵌套层数过多')
  if (Array.isArray(value)) return value.map(item => rendered(item, variables, key, depth + 1))
  if (plain(value)) {
    if (value.type === 'html') throw new Error('已发布组件使用 Deep View 的声明式控件')
    if (Object.keys(value).some(name => ['__proto__', 'constructor', 'prototype'].includes(name))) throw new Error('组件字段无效')
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, rendered(child, variables, name, depth + 1)]))
  }
  if (typeof value !== 'string' || !value.includes('{{')) return value
  if (!FIELDS.has(key) && key !== 'title') throw new Error('占位符只能用于组件的显示字段和表单值')
  const get = name => {
    if (!Object.hasOwn(variables, name)) throw new Error('未声明组件参数 ' + name)
    return variables[name]
  }
  const exact = /^\{\{([a-z][a-z0-9_]{0,39})\}\}$/.exec(value)
  if (exact) return get(exact[1])
  return value.replace(PLACEHOLDER, (_, name) => String(get(name)))
}

function descriptor(input) {
  if (!plain(input) || !plain(input.view) || JSON.stringify(input).length > 10_000) throw new Error('请输入小于 10 KB 的组件定义')
  const { title, view } = input
  if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('请输入 1 至 120 字的卡片标题')
  const parameters = input.parameters ?? {}
  const functions = input.functions ?? []
  if (!plain(parameters) || Object.keys(parameters).length > 16 || !Array.isArray(functions) ||
      !functions.every(name => typeof name === 'string' && Object.hasOwn(DATA, name))) throw new Error('组件参数或数据函数无效')
  const types = new Map(Object.entries(parameters))
  for (const [name, type] of types) {
    if (!SLOT.test(name) || !Object.hasOwn(sampleValues, type)) throw new Error('参数需要名称及 string、number 或 boolean 类型')
  }
  for (const name of new Set(functions)) {
    for (const [slot, type] of Object.entries(DATA[name].slots)) {
      if (types.has(slot)) throw new Error('组件参数与数据函数字段重名：' + slot)
      types.set(slot, type)
    }
  }
  const clean = { title: title.trim(), view, parameters, functions: [...new Set(functions)] }
  const example = Object.fromEntries([...types].map(([name, type]) => [name, sampleValues[type]]))
  checkComponent(clean, example)
  return { clean, example }
}

function checkComponent(template, values) {
  const title = rendered(template.title, values, 'title')
  const view = rendered(template.view, values, undefined)
  const result = checkShownView(title, view)
  if (result.error !== undefined) throw new Error(result.error)
  return result
}

export function previewComponent(input) {
  const { clean, example } = descriptor(input)
  return checkComponent(clean, example)
}

export function componentRegistry(rt) {
  const list = () => rt.state.components ??= []
  const get = name => list().find(component => component.name === name)
  const view = () => ({ version: 1, components: list(), functions: Object.entries(DATA).map(([id, { title, slots }]) => ({ id, title, slots })) })
  let saving = Promise.resolve()

  async function handle(req) {
    await rt.load()
    if (req.action === 'components.list') return view()
    if (req.action === 'components.preview') return previewComponent(req.template)
    const write = saving.then(() => change(req))
    saving = write.catch(() => {})
    return write
  }

  async function change(req) {
    const name = typeof req.name === 'string' ? req.name.trim() : ''
    if (!NAME.test(name)) throw new Error('组件名称使用小写字母、数字和连字符')
    const previous = get(name)
    let next
    switch (req.action) {
      case 'components.save': {
        const { clean } = descriptor(req.template)
        next = { ...previous, name, draft: clean, bots: previous?.bots ?? [], allowedFunctions: previous?.allowedFunctions ?? [] }
        break
      }
      case 'components.publish':
        if (!previous?.draft) throw new Error('请先保存组件草稿')
        next = { ...previous, published: { version: (previous.revision ?? 0) + 1, template: previous.draft, at: Date.now() }, revision: (previous.revision ?? 0) + 1 }
        break
      case 'components.unpublish':
        if (!previous) throw new Error('没有这个组件')
        next = { ...previous, published: null }
        break
      case 'components.grants':
        if (!previous || !Array.isArray(req.bots) || !Array.isArray(req.functions) ||
            !req.bots.every(id => typeof id === 'string' && rt.botOf(id)) ||
            !req.functions.every(id => typeof id === 'string' && Object.hasOwn(DATA, id))) throw new Error('组件授权无效')
        next = { ...previous, bots: [...new Set(req.bots)], allowedFunctions: [...new Set(req.functions)] }
        break
      default:
        throw new Error('未知组件操作')
    }
    const before = list()
    if (!previous && before.length >= 100) throw new Error('组件目录已满')
    rt.state.components = previous ? before.map(item => item === previous ? next : item) : [...before, next]
    try { await rt.save({ required: true }) }
    catch (error) { rt.state.components = before; throw error }
    return view()
  }

  function visible(botId) {
    return list().flatMap(item => item.published && item.bots.includes(botId) && item.published.template.functions.every(id => item.allowedFunctions.includes(id)) ? [{
      name: item.name,
      title: item.published.template.title,
      version: item.published.version,
      parameters: item.published.template.parameters,
    }] : [])
  }

  function render(bot, name, args = {}) {
    const item = get(name)
    if (!bot || !item?.published || !item.bots.includes(bot.id)) throw new Error('该 Bot 没有此组件的发布授权')
    const { template, version } = item.published
    if (!plain(args) || Object.keys(args).some(key => !Object.hasOwn(template.parameters, key))) throw new Error('参数不在组件定义中')
    for (const [key, type] of Object.entries(template.parameters)) {
      const provided = own(args, key)
      if (typeof provided !== type || !scalar(provided)) throw new Error('组件参数 ' + key + ' 需要类型 ' + type)
      if (typeof provided === 'string' && rt.redactSecrets(provided) !== provided) throw new Error('组件参数包含已保存的凭据')
    }
    const values = { ...args }
    for (const id of template.functions) {
      if (!item.allowedFunctions.includes(id)) throw new Error('组件没有数据函数授权：' + id)
      Object.assign(values, DATA[id].read(rt, bot))
    }
    return { ...checkComponent(template, values), version }
  }

  return { handle, visible, render }
}

export function install(rt) {
  rt.components = componentRegistry(rt)
}
