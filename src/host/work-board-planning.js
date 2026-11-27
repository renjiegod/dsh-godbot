import { randomUUID } from 'node:crypto'
import { boardPropertyTypes, manualStatuses, planningDefaults, priorities, viewDisplay, viewFilters } from '../team/work-board-planning.js'
import { cardId } from './work-board-index.js'

const settingCollections = { status: 'boardStatuses', property: 'boardProperties', view: 'boardViews' }
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const idPattern = /^GB-[1-9]\d{0,14}$/
const clean = (value, max) => typeof value === 'string' ? value.replaceAll('\0', '').trim().slice(0, max) : ''
const invalid = (message) => Object.assign(new Error(message), { code: 'bot/refused' })

function date(value) {
  if (!value) return ''
  if (typeof value !== 'string' || !datePattern.test(value)) throw invalid('请输入有效日期（YYYY-MM-DD）。')
  const millis = Date.parse(value)
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value)
    throw invalid('请输入有效日期（YYYY-MM-DD）。')
  return value
}

function texts(value, size, max) {
  if (!Array.isArray(value) || value.length > size || value.some(item => typeof item !== 'string' || item.length > max))
    throw invalid('字段的项目数量或长度超出限制。')
  return [...new Set(value.map(item => clean(item, max)).filter(Boolean))]
}

function boardId(value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string' || !idPattern.test(value)) throw invalid('请选择有效的工作项。')
  return value
}

function link(value) {
  let url
  try { url = new URL(value) } catch { throw invalid('请输入有效链接。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw invalid('链接需要使用 HTTP 或 HTTPS。')
  return value
}

function propertyValue(def, value, people) {
  if (value == null || value === '') return undefined
  switch (def.kind) {
    case 'text': return clean(value, 4000)
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('请输入有效数字。')
      return value
    case 'checkbox':
      if (typeof value !== 'boolean') throw invalid('请选择是或否。')
      return value
    case 'date': return date(value)
    case 'url': return link(clean(value, 2048))
    case 'textList': return texts(value, 30, 500)
    case 'urlList': return texts(value, 30, 2048).map(link)
    case 'select':
      if (!def.options.includes(value)) throw invalid('请选择属性中的选项。')
      return value
    case 'multiSelect': {
      const items = texts(value, 30, 100)
      if (items.some(item => !def.options.includes(item))) throw invalid('请选择属性中的选项。')
      return items
    }
    case 'person':
      if (!people.some(person => person.id === value)) throw invalid('请选择有效的成员。')
      return value
    case 'people': {
      const ids = texts(value, 30, 210)
      if (ids.some(id => !people.some(person => person.id === id))) throw invalid('请选择有效的成员。')
      return ids
    }
  }
}

export function boardCatalog(db, access) {
  const read = db.prepare('SELECT data FROM records WHERE collection=? ORDER BY seq')
  const rows = (name) => read.all(name).map(row => JSON.parse(row.data))
  return {
    statuses: rows(settingCollections.status),
    properties: rows(settingCollections.property),
    views: rows(settingCollections.view),
    assignees: [
      { id: 'person/owner', name: 'Workspace owner', kind: 'person' },
      ...rows('humanPeople').filter(p => !p.disabled && !p.revoked && !p.revokedAt && p.id && p.name)
        .map(p => ({ id: 'person/' + p.id, name: p.name, kind: 'person' })),
      ...access.bots.map(b => ({ id: 'bot/' + b.id, name: b.name, kind: 'bot' })),
      ...access.rooms.map(r => ({ id: 'room/' + r.id, name: r.name, kind: 'room' })),
    ],
  }
}
export function planningFields(meta) {
  return Object.fromEntries(Object.entries(planningDefaults).map(([key, value]) => [key, meta[key] ?? value]))
}
export function statusFor(id, statuses) {
  return Object.hasOwn(manualStatuses, id) ? manualStatuses[id] : statuses.find(status => status.id === id)
}

export function editPlanning(meta, req, rowKind, phase, catalog) {
  for (const key of ['description', 'startDate', 'dueDate', 'labels', 'statusId', 'assignee']) {
    if (!Object.hasOwn(req, key)) continue
    switch (key) {
      case 'description': meta.description = clean(req.description, 16000); break
      case 'labels': meta.labels = texts(req.labels, 30, 64); break
      case 'startDate': case 'dueDate': meta[key] = date(req[key]); break
      case 'statusId': {
        const id = clean(req.statusId, 64)
        const status = id && statusFor(id, catalog.statuses)
        if (id && (!status || (status.archived && meta.statusId !== id))) throw invalid('请选择有效的任务状态。')
        if (status && rowKind !== 'draft' && status.phase !== phase)
          throw invalid('派工的状态由当前运行和验收结果决定。')
        meta.statusId = id
        meta.statusPhase = status?.phase || ''
        break
      }
      case 'assignee': {
        const id = clean(req.assignee, 210)
        if (id && !catalog.assignees.some(assignee => assignee.id === id)) throw invalid('请选择可访问的负责人。')
        if (rowKind !== 'draft' && meta.assignee !== id) throw invalid('请通过转交操作修改执行负责人。')
        meta.assignee = id
        if (rowKind === 'draft') meta.owner = id.startsWith('bot/') ? id.slice(4) : null
        break
      }
    }
  }
  if (meta.startDate && meta.dueDate && meta.startDate > meta.dueDate)
    throw invalid('开始日期不能晚于截止日期。')
  if (Object.hasOwn(req, 'priority')) {
    if (!Object.hasOwn(priorities, req.priority)) throw invalid('请选择有效的优先级。')
    meta.priority = Number(req.priority)
  }
  if (req.addLabels || req.removeLabels) {
    const labels = new Set([...(meta.labels ?? []), ...texts(req.addLabels ?? [], 30, 64)])
    for (const label of texts(req.removeLabels ?? [], 30, 64)) labels.delete(label)
    meta.labels = texts([...labels], 30, 64)
  }
  if (req.customValues != null) {
    if (typeof req.customValues !== 'object' || Array.isArray(req.customValues)) throw invalid('无效的自定义属性。')
    const values = { ...meta.customValues }
    const people = catalog.assignees.filter(a => a.kind === 'person')
    for (const [key, value] of Object.entries(req.customValues)) {
      const def = catalog.properties.find(p => p.id === key && !p.archived)
      if (!def) throw invalid('该自定义属性已删除或归档。')
      const next = propertyValue(def, value, people)
      if (next === undefined) delete values[key]
      else values[key] = next
    }
    meta.customValues = values
  }
  if (Object.hasOwn(req, 'parent')) meta.parent = boardId(req.parent)
  if (Object.hasOwn(req, 'duplicateOf')) meta.duplicateOf = boardId(req.duplicateOf)
  if (Object.hasOwn(req, 'blockedBy')) meta.blockedBy = texts(req.blockedBy, 40, 18).map(boardId)
  if (Object.hasOwn(req, 'stage')) {
    if (!Number.isInteger(req.stage) || req.stage < 0 || req.stage > 99) throw invalid('子任务阶段必须为 0–99。')
    meta.stage = req.stage
  }
  if (meta.stage && !meta.parent) throw invalid('为子任务设置阶段前，请先选择父任务。')
}

export function mutateBoardCatalog(store, req) {
  if (!Object.hasOwn(settingCollections, req.kind)) throw invalid('未知的看板设置。')
  const collection = settingCollections[req.kind]
  const prior = req.id ? store.require(collection, req.id) : null
  if (prior && prior.revision !== req.revision) throw invalid('看板设置已更新，请重新打开。')
  if (req.op === 'remove') {
    if (!prior) throw invalid('找不到该设置。')
    if (req.kind === 'view') store.remove(collection, prior.id)
    else store.update(collection, prior.id, { archived: true, revision: prior.revision + 1 })
    return { id: prior.id }
  }
  const id = prior?.id ?? randomUUID()
  const name = clean(req.name, 70)
  if (!name || store.all(collection).some(entry => entry.id !== id && !entry.archived && entry.name === name))
    throw invalid('请填写未使用的名称。')
  const fields = { id, name, revision: (prior?.revision ?? 0) + 1, archived: false }
  switch (req.kind) {
    case 'status':
      if (!['todo', 'doing', 'attention', 'review', 'done', 'history'].includes(req.phase)) throw invalid('请选择状态分类。')
      if (prior && prior.phase !== req.phase) throw invalid('已创建状态的分类不能修改。')
      fields.phase = req.phase
      break
    case 'property':
      if (!Object.hasOwn(boardPropertyTypes, req.propertyType)) throw invalid('请选择属性类型。')
      if (prior && prior.kind !== req.propertyType) throw invalid('已创建属性的类型不能修改。')
      fields.kind = req.propertyType
      if (['select', 'multiSelect'].includes(fields.kind)) {
        fields.options = texts(req.options, 40, 100)
        if (!fields.options.length) throw invalid('至少填写一个选项。')
      }
      break
    case 'view':
      fields.visibility = req.visibility === 'shared' ? 'shared' : 'private'
      fields.filters = viewFilters(req.filters)
      fields.display = viewDisplay(req.display)
      break
  }
  return store.put(collection, fields)
}

export class BoardRelations {
  constructor(board, checkedRow, readOnly = false) {
    this.board = board
    this.checked = checkedRow
    const db = board.db
    if (!readOnly) db.exec(`CREATE INDEX IF NOT EXISTS board_parent ON board_cards(json_extract(meta,'$.parent'));
      CREATE INDEX IF NOT EXISTS board_duplicate ON board_cards(json_extract(meta,'$.duplicateOf'));
      CREATE INDEX IF NOT EXISTS board_waiting_dispatch ON board_cards(number)
        WHERE kind='draft' AND json_extract(meta,'$.dispatchPending') IS NOT NULL`)
    this.children = db.prepare("SELECT * FROM board_cards WHERE json_extract(meta,'$.parent')=? ORDER BY json_extract(meta,'$.stage'),number")
    this.duplicates = db.prepare("SELECT * FROM board_cards WHERE json_extract(meta,'$.duplicateOf')=? ORDER BY number")
    this.dependents = db.prepare("SELECT * FROM board_cards WHERE EXISTS (SELECT 1 FROM json_each(meta,'$.blockedBy') WHERE value=?) ORDER BY number")
    this.update = db.prepare('UPDATE board_cards SET meta=? WHERE number=?')
    this.waiting = db.prepare("SELECT * FROM board_cards WHERE kind='draft' AND json_extract(meta,'$.dispatchPending') IS NOT NULL ORDER BY number")
    this.history = db.prepare("SELECT data FROM records WHERE collection='boardEditHistory' AND json_extract(data,'$.number')=? ORDER BY seq DESC LIMIT 50")
    if (!readOnly) db.exec("CREATE INDEX IF NOT EXISTS board_edits ON records(json_extract(data,'$.number'),seq) WHERE collection='boardEditHistory'")
  }
  byId(id) {
    return idPattern.test(id ?? '') ? this.board.byNumber.get(Number(id.slice(3))) : null
  }
  peers(meta) {
    if (!meta.parent || !meta.stage) return []
    return this.children.all(meta.parent).filter(row => {
      const p = JSON.parse(row.meta)
      return p.stage > 0 && p.stage < meta.stage
    }).map(row => cardId(row.number))
  }
  prerequisites(row, meta) {
    const source = row.kind === 'task' && this.board.store.get('tasks', row.source_id)
    const existing = (source?.dependsOn ?? []).flatMap(id => {
      const reference = this.board.source.get('task', '', id)
      return reference ? [cardId(reference.number)] : []
    })
    return [...new Set([...(meta.blockedBy ?? []), ...this.peers(meta), ...existing])]
  }
  assertValid(row, meta, before) {
    const self = cardId(row.number)
    for (const id of [meta.parent, meta.duplicateOf, ...(meta.blockedBy ?? [])].filter(Boolean)) {
      if (id === self) throw invalid('工作项不能关联自身。')
      if (before.parent !== id && before.duplicateOf !== id && !(before.blockedBy ?? []).includes(id))
        this.checked({ id })
    }
    for (let parent = meta.parent, seen = new Set([self]); parent;) {
      if (seen.has(parent)) throw invalid('父子任务不能形成循环。')
      seen.add(parent)
      const next = this.byId(parent)
      parent = next && JSON.parse(next.meta).parent
    }
    if (meta.duplicateOf && (JSON.parse(this.byId(meta.duplicateOf).meta).duplicateOf || this.duplicates.get(self)))
      throw invalid('重复项只能指向一张原始工作项。')
    if (meta.duplicateOf && !before.duplicateOf && row.kind !== 'draft' && !['done', 'history'].includes(JSON.parse(row.summary).phase))
      throw invalid('请先结束现有派工，再标记为重复。')
    const expanded = new Set(), visiting = new Set()
    const walk = (id) => {
      if (visiting.has(id)) throw invalid('任务依赖不能形成循环。')
      if (expanded.has(id)) return
      const current = this.byId(id)
      if (!current) return
      visiting.add(id)
      const linked = JSON.parse(current.meta)
      for (const next of this.prerequisites(current, linked)) walk(next)
      if (linked.duplicateOf) walk(linked.duplicateOf)
      visiting.delete(id)
      expanded.add(id)
    }
    walk(self)
    for (const family of new Set([meta.parent, before.parent].filter(Boolean))) {
      for (const child of this.children.all(family)) walk(cardId(child.number))
    }
  }
  save(row, before, meta) {
    this.update.run(JSON.stringify(meta), row.number)
    if (['parent', 'stage', 'blockedBy', 'duplicateOf'].some(key => JSON.stringify(before[key]) !== JSON.stringify(meta[key])))
      this.assertValid(this.board.byNumber.get(row.number), meta, before)
  }
  visible(id) {
    try {
      const row = this.checked({ id })
      const data = JSON.parse(row.summary)
      return { id, title: data.title, phase: data.phase, mark: data.mark, stage: JSON.parse(row.meta).stage ?? 0 }
    } catch { return null }
  }
  pending(row, meta) {
    const task = row.kind === 'task' && this.board.store.get('tasks', row.source_id)
    return this.prerequisites(row, meta).filter(id => {
      const candidate = this.visible(id)
      if (!candidate) return true
      if (candidate.phase === 'done') return false
      const source = this.byId(id)
      if (candidate.mark === 'skipped' && task?.workflowInputs && task.dependsOn?.includes(source.source_id)) return false
      return candidate.mark !== 'duplicate' || this.visible(JSON.parse(source.meta).duplicateOf)?.phase !== 'done'
    })
  }
  detail(row, item) {
    const meta = JSON.parse(row.meta)
    const id = cardId(row.number)
    const refs = ids => ids.map(key => this.visible(key)).filter(Boolean)
    const children = refs(this.children.all(id).map(child => cardId(child.number)))
    const visiblePrerequisites = refs(this.prerequisites(row, meta))
    const pending = this.pending(row, meta)
    const source = item.snapshot && this.visible(item.snapshot.id)
    const incoming = this.dependents.all(id).map(r => cardId(r.number))
    for (const peer of this.children.all(meta.parent || id)) {
      if (this.peers(JSON.parse(peer.meta)).includes(id)) incoming.push(cardId(peer.number))
    }
    return {
      parent: this.visible(meta.parent),
      duplicateOf: this.visible(meta.duplicateOf),
      duplicates: refs(this.duplicates.all(id).map(r => cardId(r.number))),
      children,
      progress: { completed: children.filter(c => c.phase === 'done').length, total: children.length },
      prerequisites: visiblePrerequisites,
      dependents: refs([...new Set(incoming)]),
      waiting: pending.length,
      restricted: pending.filter(key => !this.visible(key)).length,
      pendingDispatch: Boolean(meta.dispatchPending),
      snapshot: source ? item.snapshot : undefined,
      audit: this.history.all(row.number).map(entry => JSON.parse(entry.data)),
    }
  }
}
