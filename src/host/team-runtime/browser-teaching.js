import { randomUUID } from 'node:crypto'
import { looksLikeKey, looksSecret } from './core/memory-entries.js'

const MAX_STEPS = 160
const MAX_SAVED = 24
const ELEMENTS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'])
const INPUTS = new Set(['button', 'checkbox', 'date', 'email', 'file', 'number', 'radio', 'search', 'submit', 'tel', 'text', 'url'])
const KEYS = new Set(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

function originOf(value) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) return undefined
  return url.origin
}

export function demonstrationStep(input, before, after, element) {
  const source = originOf(before)
  const target = originOf(after)
  const step = { action: input.kind, ...(source ? { origin: source } : {}) }
  if (target && target !== source) step.destination = target
  switch (input.kind) {
    case 'navigate':
      return target ? { action: 'navigate', origin: target } : undefined
    case 'click':
      return {
        ...step,
        x: Math.round(input.x * 100),
        y: Math.round(input.y * 100),
        ...(ELEMENTS.has(element?.tag) ? { element: element.tag } : {}),
        ...(element?.tag === 'input' && INPUTS.has(element.type) ? { field: element.type } : {}),
        ...(Number.isInteger(element?.index) && element.index > 0 ? { index: element.index } : {}),
      }
    case 'text':
      return { ...step, action: 'fill' }
    case 'key':
      return KEYS.has(input.key) ? { ...step, key: input.key } : undefined
    case 'scroll':
      return { ...step, direction: input.delta > 0 ? 'down' : 'up' }
    default:
      return undefined
  }
}

export async function teachingTarget(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y)?.closest('a,button,input,select,textarea,summary,option')
    if (!node) return null
    const tag = node.localName
    const index = Array.from(document.getElementsByTagName(tag)).indexOf(node) + 1
    return { tag, index, ...(tag === 'input' ? { type: node.type } : {}) }
  }, { x, y }).catch(() => null)
}

export class BrowserTeaching {
  constructor(rt) {
    this.rt = rt
    this.current = new Map()
    this.drafting = new Set()
  }

  saved(botId) {
    return this.rt.state.browserDemonstrations?.[botId] ?? []
  }

  active(botId, token) {
    const row = this.current.get(botId)
    return row?.token === token ? row : undefined
  }

  start(botId, token, objective) {
    const goal = typeof objective === 'string' ? objective.trim() : ''
    if (!goal || goal.length > 400) throw new Error('请输入 1 至 400 字的示范目标')
    if (looksLikeKey(goal) || looksSecret(goal) || this.rt.redactSecrets(goal) !== goal) throw new Error('示范目标包含疑似敏感信息')
    if (this.current.has(botId)) throw new Error('这个 Bot 已在录制示范')
    const row = { id: randomUUID(), botId, token, goal, startedAt: Date.now(), steps: [] }
    this.current.set(botId, row)
    return { id: row.id, count: 0 }
  }

  note(botId, token, input, before, after, element) {
    const row = this.active(botId, token)
    if (!row || row.steps.length >= MAX_STEPS) return
    const step = demonstrationStep(input, before, after, element)
    if (!step) return
    const previous = row.steps.at(-1)
    if (step.action === 'scroll' && previous?.action === 'scroll' && step.direction === previous.direction && step.origin === previous.origin) return
    row.steps.push(step)
  }

  async stop(botId, token) {
    const row = this.active(botId, token)
    if (!row) return null
    if (!row.steps.length) {
      this.current.delete(botId)
      return null
    }
    const { token: _token, ...record } = row
    const saved = { ...record, endedAt: Date.now(), capped: row.steps.length === MAX_STEPS }
    this.rt.state.browserDemonstrations ??= {}
    const previous = this.saved(botId)
    this.rt.state.browserDemonstrations[botId] = [...previous, saved].slice(-MAX_SAVED)
    this.current.delete(botId)
    try { await this.rt.save({ required: true }) }
    catch (error) {
      this.rt.state.browserDemonstrations[botId] = previous
      this.current.set(botId, row)
      throw error
    }
    return saved
  }

  async remove(botId, id) {
    if (this.drafting.has(id)) throw new Error('正在整理这段示范')
    const rows = this.saved(botId)
    const kept = rows.filter(row => row.id !== id)
    if (kept.length === rows.length) throw new Error('没有这段示范')
    this.rt.state.browserDemonstrations[botId] = kept
    try { await this.rt.save({ required: true }) }
    catch (error) {
      this.rt.state.browserDemonstrations[botId] = rows
      throw error
    }
    return { removed: true }
  }

  async draft(botId, id) {
    const row = this.saved(botId).find(entry => entry.id === id)
    if (!row) throw new Error('没有这段示范')
    if (this.drafting.has(id)) throw new Error('正在整理这段示范')
    if (!this.rt.proposeBrowserSkill) throw new Error('当前工作区的技能学习已关闭')
    this.drafting.add(id)
    try { return await this.rt.proposeBrowserSkill(row) }
    finally { this.drafting.delete(id) }
  }
}
