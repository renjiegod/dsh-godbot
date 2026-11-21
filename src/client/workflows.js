import { Fragment, createElement as h, useEffect, useId, useMemo, useRef, useState } from 'react'
import { badge, button, empty, field, option, row, stamp } from './controls.js'
import { pendingRequests, statusText } from './model.js'
import { WorkflowFiles } from './workflow-files.js'
import graphStyle from './workflows.css'

const edgeTypes = { accepted: '验收通过', contains: '验收证据包含', 'not-contains': '验收证据不包含' }
const joinTypes = { all: '全部条件满足', any: '任一条件满足' }
const states = { pending: '待派工', skipped: '已跳过', 'needs-review': '待验收', running: '运行中', completed: '已完成' }
const freshEdge = () => ({ from: '', to: '', when: 'accepted', value: '' })
const nodeWidth = 156, nodeHeight = 58, columnGap = 72, rowGap = 34, padding = 24

function layoutGraph(nodes, edges) {
  const outgoing = new Map(nodes.map(n => [n.id, []]))
  const remaining = new Map(nodes.map(n => [n.id, 0]))
  const depth = new Map(nodes.map(n => [n.id, 0]))
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge.to)
    remaining.set(edge.to, remaining.get(edge.to) + 1)
  }
  const ordered = nodes.filter(n => !remaining.get(n.id)).map(n => n.id)
  for (const id of ordered) {
    for (const next of outgoing.get(id)) {
      depth.set(next, Math.max(depth.get(next), depth.get(id) + 1))
      remaining.set(next, remaining.get(next) - 1)
      if (!remaining.get(next)) ordered.push(next)
    }
  }
  const columns = []
  for (const node of nodes) (columns[depth.get(node.id)] ??= []).push(node)
  const count = Math.max(1, ...columns.map(column => column.length))
  const lanes = new Map()
  for (const edge of edges) if (depth.get(edge.to) > depth.get(edge.from) + 1) lanes.set(edge, 14 + lanes.size * 12)
  const top = padding + lanes.size * 12
  const positions = new Map()
  columns.forEach((column, level) => {
    column.forEach((node, index) => positions.set(node.id, {
      x: padding + level * (nodeWidth + columnGap),
      y: top + (index + (count - column.length) / 2) * (nodeHeight + rowGap),
    }))
  })
  return { positions, lanes, width: padding * 2 + Math.max(1, columns.length) * (nodeWidth + columnGap) - columnGap,
    height: padding + top + count * (nodeHeight + rowGap) - rowGap }
}

function validateEdge(nodes, edges, edge) {
  if (!nodes.some(n => n.id === edge.from) || !nodes.some(n => n.id === edge.to)) return '请选择连线的起点和终点。'
  if (edge.from === edge.to) return '起点和终点不能是同一节点。'
  if (edges.some(e => e.from === edge.from && e.to === edge.to)) return '这两个节点之间已有连线。'
  if (edge.when !== 'accepted' && !edge.value.trim()) return '请输入要匹配的验收证据文本。'
  const visited = new Set([edge.to])
  for (const id of visited) {
    if (id === edge.from) return '此连线会形成循环，请更换节点。'
    for (const next of edges) if (next.from === id) visited.add(next.to)
  }
  return ''
}

function Graph({ nodes, edges, bots, selected, picking, onNode, onEdge, disabled, execution }) {
  const { positions, lanes, width, height } = useMemo(() => layoutGraph(nodes, edges), [nodes, edges])
  const marker = 'gb-arrow-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  if (!nodes.length) return empty('添加第一个节点，指定负责 Bot和验收标准。')
  return h('div', { className: 'gb-flow-scroll', role: 'group', 'aria-label': execution ? '本次运行的节点图' : '工作流节点图', tabIndex: 0 },
    h('div', { className: 'gb-flow-canvas', style: { width, height } },
      h('svg', { className: 'gb-flow-wires', width, height, 'aria-hidden': true },
        h('defs', null, h('marker', { id: marker, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' },
          h('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'var(--bt-ink-2)' }))),
        edges.map((edge, i) => {
          const start = positions.get(edge.from), end = positions.get(edge.to)
          const sx = start.x + nodeWidth, sy = start.y + nodeHeight / 2, ex = end.x - 3, ey = end.y + nodeHeight / 2
          const lane = lanes.get(edge)
          const d = lane === undefined
            ? `M ${sx} ${sy} C ${sx + columnGap / 2} ${sy}, ${ex - columnGap / 2} ${ey}, ${ex} ${ey}`
            : `M ${sx} ${sy} H ${sx + 12} V ${lane} H ${ex - 12} V ${ey} H ${ex}`
          return h('g', { key: edge.from + '/' + edge.to },
            h('path', { d, fill: 'none', stroke: 'var(--bt-ink-2)', strokeWidth: 1.7,
              strokeDasharray: edge.when === 'accepted' ? undefined : '5 4', markerEnd: 'url(#' + marker + ')' }),
            h('path', { d, fill: 'none', stroke: 'transparent', strokeWidth: 14, className: 'gb-flow-hit',
              style: execution ? { cursor: 'default' } : undefined, onClick: () => { if (!disabled) onEdge?.(i) } },
              h('title', null, edgeTypes[edge.when] + (edge.value ? ' · ' + edge.value : ''))))
        })),
      nodes.map(node => {
        const pos = positions.get(node.id)
        const result = execution?.get(node.id)
        const title = node.title || '未命名节点'
        const subtitle = execution ? (states[result?.status] || statusText(result?.status)) :
          (bots.find(m => m.id === node.ownerId)?.name ?? '待指定负责人')
        return button(h('span', null,
          h('strong', null, title), h('small', null, subtitle)),
          () => onNode(node.id), { key: node.id, className: 'gb-flow-node', style: { left: pos.x, top: pos.y, width: nodeWidth, height: nodeHeight },
            'aria-label': execution ? '查看节点任务 ' + title + ' · ' + subtitle : (picking ? '连接到 ' : '选择节点 ') + title,
            'aria-pressed': execution ? undefined : selected === node.id, 'data-run-status': result?.status,
            disabled: disabled || picking === node.id || (execution && !result?.taskId) })
      })))
}

function History({ runs, workflow, tasks, onTask, activeId }) {
  const [viewId, setViewId] = useState('')
  const items = runs.filter(run => run.workflowId === workflow.id)
  const selected = items.find(r => r.id === (viewId || activeId)) ?? items[0]
  const available = new Set(tasks.map(task => task.id))
  const execution = new Map(selected?.nodes.map(n => [n.nodeId, { status: n.status, taskId: available.has(n.taskId) ? n.taskId : null }]))
  return h('section', { className: 'gb-stack gb-flow-history', 'aria-label': '工作流运行记录' },
    h('h3', null, '运行记录'),
    !items.length ? empty('这个工作流还没有运行记录。') : h(Fragment, null,
      field('选择运行记录', h('select', { value: selected.id, onChange: e => setViewId(e.target.value) },
        items.map(r => option(r.id, (stamp(r.createdAt) || r.id.slice(0, 8)) + ' · v' + r.workflowRevision + ' · ' + (states[r.status] || statusText(r.status)))))),
      h('div', { key: 'details', className: 'gb-stack' },
        row(badge(selected.status, states[selected.status] || statusText(selected.status)), h('small', null, selected.id)),
        selected.definition && h('details', { className: 'gb-flow-run-graph' },
          h('summary', null, '本次运行的流程图'),
          h('small', null, selected.name + ' · v' + selected.workflowRevision),
          h(Graph, { nodes: selected.definition.nodes, edges: selected.definition.edges, execution,
            onNode: id => onTask(execution.get(id).taskId) })),
        h('ul', { className: 'gb-flow-run-nodes' }, selected.nodes.map(n => {
          const task = tasks.find(t => t.id === n.taskId)
          const title = n.title || task?.title || workflow.nodes.find(def => def.id === n.nodeId)?.title || n.nodeId
          return h('li', { key: n.nodeId }, h('span', null, title), badge(n.status, states[n.status] || statusText(n.status)),
            n.taskId && button('查看任务', () => onTask(n.taskId), { 'aria-label': '查看任务 ' + title, disabled: !task }))
        }))),
    ))
}

export function Workflows({ workspace, bots, tasks, client, refresh, readOnly, onTask, focusWorkflowId, focusRunId }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [editing, setEditing] = useState(false)
  const [nodeId, setNodeId] = useState('')
  const [edge, setEdge] = useState(freshEdge)
  const [editEdge, setEditEdge] = useState(null)
  const [picking, setPicking] = useState('')
  const [pendingChoice, setPendingChoice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeRun, setActiveRun] = useState(focusRunId ?? '')
  const [epoch, reload] = useState(0)
  const [ledger] = useState(() => {
    try { return pendingRequests(window.sessionStorage) } catch { return pendingRequests() }
  })
  const mounted = useRef(false), pending = useRef(false)
  const listVersion = useRef(0)
  const unsaved = useRef(false)
  const teamId = workspace.id
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let live = true, timer
    async function load() {
      const version = listVersion.current
      try {
        const value = await client.dispatch({ action: 'workflow.list', teamId })
        if (!live || version !== listVersion.current) return
        setData(value)
        setDraft(before => before ?? value.workflows.find(w => w.id === focusWorkflowId) ?? value.workflows[0] ?? null)
        setLoadError('')
      } catch (cause) {
        if (live && version === listVersion.current) setLoadError(cause.message || String(cause))
      } finally {
        if (live) timer = setTimeout(load, document.hidden ? 30000 : 3500)
      }
    }
    void load()
    return () => { live = false; clearTimeout(timer) }
  }, [client, teamId, epoch, focusWorkflowId])

  // A saved revision may change in another browser while this browser edits it.
  const saved = data?.workflows.find(w => w.id === draft?.id)
  const current = editing ? draft : saved ?? draft ?? data?.workflows[0]
  const node = current?.nodes.find(n => n.id === nodeId) ?? current?.nodes[0]
  const blocked = busy || readOnly
  function reloadData() {
    listVersion.current++
    reload(v => v + 1)
  }
  unsaved.current = editing && (draft.id || draft.name || draft.nodes.length)
  function resetControls(value) {
    setNodeId(value?.nodes[0]?.id ?? '')
    setEdge(freshEdge())
    setEditEdge(null)
    setPicking('')
    setPendingChoice(null)
    setError('')
    setNotice('')
    setActiveRun('')
  }
  function open(id) {
    const value = id ? data.workflows.find(w => w.id === id) : { name: '', nodes: [], edges: [] }
    setDraft(value)
    setEditing(!id)
    resetControls(value)
  }
  function choose(id) {
    if (editing && (draft.id || draft.name || draft.nodes.length)) return setPendingChoice({ id })
    open(id)
  }
  function update(patch) {
    if (blocked) return
    setEditing(true)
    setDraft({ ...current, ...patch })
    setError('')
    setNotice('')
  }
  function addNode() {
    const id = 'node-' + crypto.randomUUID()
    const next = { id, title: '节点 ' + (current.nodes.length + 1), ownerId: bots.find(bot => bot.id === workspace.leadId)?.id ?? bots[0]?.id ?? '', criteria: '', join: 'all' }
    update({ nodes: [...current.nodes, next] })
    setNodeId(id)
    setPicking('')
  }
  function changeNode(patch) {
    update({ nodes: current.nodes.map(n => n.id === node.id ? { ...n, ...patch } : n) })
  }
  function removeNode() {
    const nodes = current.nodes.filter(n => n.id !== node.id)
    update({ nodes, edges: current.edges.filter(e => e.from !== node.id && e.to !== node.id) })
    setNodeId(nodes[0]?.id ?? '')
    resetLink()
  }
  function resetLink() {
    setEdge(freshEdge())
    setEditEdge(null)
    setPicking('')
  }
  function selectEdge(index) {
    if (!editing) update({})
    const chosen = current.edges[index]
    setEdge({ ...freshEdge(), ...chosen })
    setEditEdge(index)
    setPicking('')
    setError('')
  }
  function pickNode(id) {
    if (picking) {
      setEdge({ ...freshEdge(), from: picking, to: id })
      setPicking('')
      setError('')
    } else setNodeId(id)
  }
  function applyLink() {
    const others = current.edges.filter((_, index) => index !== editEdge)
    const issue = validateEdge(current.nodes, others, edge)
    if (issue) return setError(issue)
    const { from, to, when } = edge
    const value = { from, to, when, ...(when === 'accepted' ? {} : { value: edge.value.trim() }) }
    update({ edges: editEdge === null ? [...others, value] : current.edges.map((old, index) => index === editEdge ? value : old) })
    resetLink()
  }
  async function mutate(action, fields, applied) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setNotice('')
    setError('')
    try {
      const request = { action, teamId, ...fields }
      const ticket = await ledger.begin(request)
      const value = await client.dispatch({ ...request, requestId: ticket.id })
      ledger.complete(ticket)
      if (!mounted.current) return
      applied(value)
      reloadData()
      void refresh()
    } catch (cause) {
      if (mounted.current) {
        setError(cause.message || String(cause))
        reloadData()
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  function save() {
    if (!current.name.trim()) return setError('请输入工作流名称。')
    if (!current.nodes.length) return setError('请至少添加一个节点。')
    const invalid = current.nodes.find(n => !n.title.trim() || !n.criteria.trim() || !bots.some(m => m.id === n.ownerId))
    if (invalid) {
      setNodeId(invalid.id)
      return setError('请填写所选节点的名称、负责人和验收标准。')
    }
    if (edge.from || edge.to || editEdge !== null) return setError('请先应用或取消正在编辑的连线。')
    const { id, revision, name, nodes, edges } = current
    void mutate('workflow.save', { ...(id ? { id, expectedRevision: revision } : {}), name: name.trim(), nodes, edges }, value => {
      setDraft(value)
      setData(before => ({ workflows: [value, ...(before?.workflows ?? []).filter(w => w.id !== value.id)], runs: before?.runs ?? [] }))
      setEditing(false)
      setNotice('已保存工作流 v' + value.revision)
    })
  }
  function start() {
    const { id, revision } = current
    void mutate('workflow.run', { id, expectedRevision: revision }, value => {
      setData(before => ({ workflows: before.workflows, runs: [value, ...before.runs.filter(r => r.id !== value.id)] }))
      setActiveRun(value.id)
      setNotice('已启动工作流 v' + revision)
    })
  }
  function imported(value) {
    setData(before => ({ workflows: [value, ...(before?.workflows ?? []).filter(w => w.id !== value.id)], runs: before?.runs ?? [] }))
    if (unsaved.current || pending.current) setPendingChoice({ id: value.id })
    else {
      setDraft(value)
      setEditing(false)
      resetControls(value)
    }
    reloadData()
  }
  const inputs = { disabled: blocked }
  const nodeOptions = () => [option('', '请选择'), ...current.nodes.map(n => option(n.id, n.title || '未命名节点'))]
  const stale = editing && saved && saved.revision !== current.revision
  function chooseLinkEnd(name, value) {
    if (!editing) update({})
    setEdge({ ...edge, [name]: value })
    setError('')
    setPicking('')
  }
  return h('section', { className: 'gb-section gb-stack gb-workflows', 'aria-label': '工作流' },
    h('style', null, graphStyle),
    h('div', { className: 'gb-sectionhead' }, h('h2', null, '工作流'),
      row(button('新建工作流', () => choose(''), { disabled: blocked || !data || !bots.length }),
        current?.id && button('运行工作流', start, {
          className: 'gb-primary', disabled: blocked || editing || !!edge.from || !!edge.to,
        }))),
    h('fieldset', { className: 'gb-flow-files', disabled: blocked },
      h(WorkflowFiles, { teamId, bots, workflow: data?.workflows.find(w => w.id === current?.id), client, onImported: imported })),
    loadError && h('div', { className: 'gb-alert', role: 'alert' }, loadError, ' ', button('重新加载', reloadData)),
    !data && !loadError && empty('正在读取工作流…'),
    data && !current && empty(bots.length ? '还没有保存的工作流。' : '在 Bot 设置中创建 Bot 后即可分配工作流节点。'),
    data?.workflows.length > 0 && field('选择工作流', h('select', { value: current?.id || '', disabled: busy, onChange: e => choose(e.target.value) },
      !current?.id && option('', '新工作流'), data.workflows.map(w => option(w.id, w.name)))),
    pendingChoice && h('div', { className: 'gb-alert', role: 'alert' }, '放弃未保存的更改？',
      row(button('放弃更改', () => open(pendingChoice.id)), button('继续编辑', () => setPendingChoice(null)))),
    current && h('div', { className: 'gb-stack' },
      field('工作流名称', h('input', { ...inputs, value: current.name, onChange: e => update({ name: e.target.value }) })),
      h('div', { className: 'gb-sectionhead' }, h('h3', null, '节点与连线'), button('添加节点', addNode, { disabled: blocked || !bots.length })),
      picking && row(h('p', { role: 'status' }, '请选择连线的终点节点。'), button('取消选择', resetLink)),
      h(Graph, { nodes: current.nodes, edges: current.edges, selected: node?.id, bots, picking, onNode: pickNode, onEdge: selectEdge, disabled: busy }),
      node && h('div', { className: 'gb-flow-panel' },
        field('节点名称', h('input', { ...inputs, value: node.title, onChange: e => changeNode({ title: e.target.value }) })),
        field('负责人', h('select', { ...inputs, value: node.ownerId, onChange: e => changeNode({ ownerId: e.target.value }) },
          bots.map(m => option(m.id, m.name)))),
        field('验收标准', h('textarea', { ...inputs, value: node.criteria, rows: 2, onChange: e => changeNode({ criteria: e.target.value }) })),
        field('汇合条件', h('select', { ...inputs, value: node.join ?? 'all', onChange: e => changeNode({ join: e.target.value }) },
          Object.entries(joinTypes).map(([key, label]) => option(key, label)))),
        row(button('从此节点连线', () => { if (!editing) update({}); resetLink(); setPicking(node.id); setEdge({ ...freshEdge(), from: node.id }) }, { disabled: blocked || current.nodes.length < 2 }),
          button('删除节点', removeNode, { disabled: blocked, className: 'gb-danger' }))),
      current.nodes.length > 1 && h('div', { className: 'gb-stack gb-flow-links' },
        h('h3', null, '连线'),
        current.edges.length > 0 && h('ul', { className: 'gb-flow-edge-list' }, current.edges.map((e, i) => {
          const name = id => current.nodes.find(n => n.id === id)?.title || '未命名节点'
          return h('li', { key: e.from + '/' + e.to }, button(name(e.from) + ' → ' + name(e.to) + ' · ' + edgeTypes[e.when] + (e.value ? ' ' + e.value : ''),
            () => selectEdge(i), { disabled: blocked, 'aria-pressed': editEdge === i }))
        })),
        h('div', { className: 'gb-flow-panel' },
          field('起点', h('select', { ...inputs, value: edge.from, onChange: e => chooseLinkEnd('from', e.target.value) }, nodeOptions())),
          field('终点', h('select', { ...inputs, value: edge.to, onChange: e => chooseLinkEnd('to', e.target.value) }, nodeOptions())),
          field('连线条件', h('select', { ...inputs, value: edge.when, onChange: e => chooseLinkEnd('when', e.target.value) },
            Object.entries(edgeTypes).map(([key, label]) => option(key, label)))),
          edge.when !== 'accepted' && field('匹配文本', h('input', { ...inputs, value: edge.value, onChange: e => chooseLinkEnd('value', e.target.value) })),
          row(button(editEdge === null ? '添加连线' : '更新连线', applyLink, { disabled: blocked || !edge.from || !edge.to }),
            editEdge !== null && button('删除连线', () => { update({ edges: current.edges.filter((_, i) => i !== editEdge) }); resetLink() }, { disabled: blocked }),
            (editEdge !== null || edge.from || edge.to) && button('取消连线编辑', resetLink, { disabled: busy })))),
      stale && h('div', { className: 'gb-alert', role: 'alert' }, '工作流已被更新。', button('载入最新版本', () => choose(saved.id))),
      error && h('p', { className: 'gb-alert', role: 'alert' }, error),
      notice && h('p', { role: 'status' }, notice),
      editing && row(button('保存工作流', save, { className: 'gb-primary', disabled: blocked || stale }),
        current.id && button('撤销更改', () => open(current.id), { disabled: busy })),
      current.id && !editing && h('details', null, h('summary', null, '从 CI 运行 · v' + current.revision),
        h('code', { className: 'gb-flow-command' }, 'godbot run --workflow ' + current.id + ' --revision ' + current.revision + ' --wait')),
      current.id && h(History, { key: current.id + '/' + activeRun, runs: data?.runs ?? [], workflow: current, tasks, activeId: activeRun, onTask })))
}
