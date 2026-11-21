import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { Icon } from './chat-ui.js'

const labels = {
  running: '运行中',
  pending: '等待中',
  completed: '完成',
  failed: '失败',
  declined: '已拒绝',
  interrupted: '已中断',
}
const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

export const executionStyle = `
.gb-execution-turn { max-width: 100%; margin: 6px 0; color: var(--bt-ink); font-size: 13px; line-height: 1.45; }
.gb-execution-list { display: grid; gap: 5px; min-width: 0; }
.gb-execution-header, .gb-execution-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gb-execution-header { justify-content: space-between; }
.gb-execution-header h3 { margin: 0; font-size: 15px; }
.gb-execution-button { min-height: 28px; padding: 3px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--bt-ink-2); font: inherit; cursor: pointer; }
.gb-execution-button:hover, .gb-execution-button[aria-pressed=true] { background: var(--bt-hover); color: var(--bt-ink); }
.gb-execution-button:focus-visible, .gb-execution-tool > summary:focus-visible, .gb-execution-select:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 1px; }
.gb-execution-tool { min-width: 0; border: 1px solid var(--bt-line); border-radius: 8px; }
.gb-execution-tool[data-child] { margin-inline-start: 12px; }
.gb-execution-tool > summary { padding: 5px 8px; cursor: pointer; }
.gb-execution-tool > summary > span { margin-inline-end: 8px; overflow-wrap: anywhere; }
.gb-execution-tool > summary > span:last-child { margin-inline-end: 0; }
.gb-execution-state, .gb-execution-meta, .gb-execution-note { color: var(--bt-ink-2); font-size: 12px; }
.gb-execution-tool[data-status=failed] .gb-execution-state, .gb-execution-error { color: var(--bt-danger); }
.gb-execution-body { display: grid; gap: 8px; padding: 6px 8px 9px; border-top: 1px solid var(--bt-line); min-width: 0; }
.gb-execution-body h4 { margin: 0 0 3px; font-size: 12px; }
.gb-execution-code { max-height: 14rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; box-sizing: border-box; margin: 0; padding: 6px 8px; border-radius: 6px; background: var(--bt-hover); font: 12px/1.5 ui-monospace, monospace; }
.gb-execution-code [data-diff=add] { color: var(--bt-green, #177246); }
.gb-execution-code [data-diff=remove] { color: var(--bt-danger); }
.gb-execution-note, .gb-execution-error { margin: 3px 0; overflow-wrap: anywhere; }
.gb-execution-pane.bt-drawer-body { gap: 10px; padding: 12px; }
.gb-execution-select { max-width: 100%; font: inherit; color: inherit; background: var(--bt-card); border: 1px solid var(--bt-line); border-radius: 6px; padding: 4px; }
.gb-execution-history-turn { border: 1px solid var(--bt-line); border-radius: 8px; }
.gb-execution-history-turn > button { display: block; width: 100%; text-align: start; }
.gb-execution-history-turn .gb-execution-list { padding: 8px; }
.gb-execution-history-turn .gb-execution-text { overflow-wrap: anywhere; }
`

function useExecution(client, botId, sessionId, { turn, toolId, expanded = true, running = false, live = false } = {}) {
  const [snapshot, setSnapshot] = useState({})
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const wasRunning = useRef(false)
  useEffect(() => {
    const settling = wasRunning.current && !running
    wasRunning.current = running
    if (!expanded && !running && !settling) {
      setLoading(false)
      return
    }
    let disposed = false, timer
    setLoading(true)
    const request = { action: 'execution.history', botId, sessionId,
      ...(turn != null ? { turn } : {}), ...(toolId != null ? { toolId } : {}) }
    const load = async () => {
      try {
        const data = await client.dispatch(request)
        if (disposed) return
        setSnapshot({ data })
        const inProgress = toolId == null
          ? data.running || data.turns?.some(item => item.running)
          : data.events?.some(item => item.status === 'running' || item.status === 'pending')
        if (running || live && inProgress) timer = setTimeout(load, 700)
      } catch {
        if (disposed) return
        setSnapshot({ error: true })
        if (running) timer = setTimeout(load, 1400)
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [client, botId, sessionId, turn, toolId, expanded, running, live, refresh])
  return { ...snapshot, loading, reload: () => setRefresh(count => count + 1) }
}

function press(text, onClick, props) {
  return h('button', { type: 'button', className: 'gb-execution-button', onClick, ...props }, text)
}

function literal(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length && value.every(block => block?.type === 'text' && typeof block.text === 'string'))
    return value.map(block => block.text).join('\n')
  return JSON.stringify(value, null, 2)
}

function Code({ value, empty, diff }) {
  if (value == null || value === '') return h('p', { className: 'gb-execution-note' }, value === '' ? '空' : empty)
  const text = literal(value)
  if (!diff || typeof value !== 'string') return h('pre', { className: 'gb-execution-code', tabIndex: 0 }, text)
  const lines = text.split('\n')
  return h('pre', { className: 'gb-execution-code', tabIndex: 0 }, lines.map((line, index) => {
    const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'remove' : undefined
    return h('span', { key: index, 'data-diff': kind }, line, index < lines.length - 1 ? '\n' : null)
  }))
}

function patchOf(file) {
  if (typeof file?.diff === 'string') return file.diff
  if (typeof file?.patch === 'string') return file.patch
  const hunks = Array.isArray(file?.hunks) ? file.hunks : [file]
  if (!hunks.length || !hunks.every(hunk => Array.isArray(hunk?.lines) && Number.isInteger(hunk.oldStart) &&
    Number.isInteger(hunk.oldLines) && Number.isInteger(hunk.newStart) && Number.isInteger(hunk.newLines))) return
  return hunks.map(hunk => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines,
  ].join('\n')).join('\n')
}

function FileChanges({ changes }) {
  const files = Array.isArray(changes) ? changes : [changes]
  if (!files.length) return h('p', { className: 'gb-execution-note' }, '无文件变更')
  return h('div', { className: 'gb-execution-list' }, files.map((file, index) => {
    const path = typeof file === 'object' && file ? file.path ?? file.filePath ?? file.file_path : undefined
    const kind = file?.type ?? file?.kind?.type ?? (typeof file?.kind === 'string' ? file.kind : undefined)
    const patch = patchOf(file)
    const beforeAfter = file?.oldText != null || file?.newText != null
    return h('div', { key: index },
      path && h('p', { className: 'gb-execution-meta' }, [kind, path].filter(Boolean).join(' · ')),
      patch != null ? h(Code, { value: patch, diff: true }) : beforeAfter
        ? h('div', { className: 'gb-execution-list' },
          file.oldText != null && h(TraceField, { label: '修改前' }, h(Code, { value: file.oldText })),
          file.newText != null && h(TraceField, { label: '修改后' }, h(Code, { value: file.newText })))
        : h(Code, { value: file }))
  }))
}

function locationText(location) {
  return typeof location === 'string' ? location : typeof location?.path === 'string'
    ? location.path + (location.line != null ? ':' + location.line : '') : ''
}

function targetOf(tool) {
  const input = tool.input
  return (Array.isArray(tool.locations) && locationText(tool.locations[0])) || tool.text ||
    input?.file_path || input?.path || input?.query?.id
}

function TraceField({ label, truncated, children }) {
  return h('div', null, h('h4', null, label), children, truncated &&
    h('p', { className: 'gb-execution-note' }, '记录超过保留上限，已截断。'))
}

function ToolOutput({ value, truncated }) {
  if (typeof value?.stdout !== 'string' && typeof value?.stderr !== 'string')
    return h(TraceField, { label: '输出', truncated }, h(Code, { value, empty: '未记录工具输出' }))
  const { stdout, stderr, ...rest } = value
  return h(TraceField, { label: '输出', truncated }, h('div', { className: 'gb-execution-list' },
    h(TraceField, { label: '标准输出' }, h(Code, { value: stdout, empty: '未记录标准输出' })),
    h(TraceField, { label: '标准错误' }, h(Code, { value: stderr, empty: '未记录标准错误' })),
    Object.keys(rest).length > 0 && h(Code, { value: rest })))
}

function ToolRow({ event, target, running }) {
  const [expanded, setExpanded] = useState(false)
  const { client, botId, sessionId, turn } = target
  const live = running && (event.status === 'running' || event.status === 'pending')
  const fetchable = event.detailAvailable !== false && typeof event.id === 'string' && event.id !== ''
  const info = useExecution(client, botId, sessionId, { turn, toolId: event.id, expanded: fetchable && expanded,
    running: fetchable && expanded && live })
  const detail = { ...event, ...info.data?.events?.[0] }
  const status = event.status ?? detail.status
  const statusLabel = !running && (status === 'running' || status === 'pending')
    ? '终态未记录' : labels[status] ?? '状态未报告'
  const toolTarget = targetOf(detail)
  const locations = Array.isArray(detail.locations) ? detail.locations.map(locationText).filter(Boolean) : []
  const truncated = key => detail.truncatedFields?.includes(key)
  const outcome = [
    typeof detail.exitCode === 'number' && '退出码 ' + detail.exitCode,
    Number.isFinite(detail.durationMs) && (detail.durationMs < 1000
      ? detail.durationMs + ' 毫秒' : (detail.durationMs / 1000).toFixed(1) + ' 秒'),
  ].filter(Boolean)
  const output = detail.output ?? detail.outputDelta
  const changes = detail.changes != null || /^(?:Edit|MultiEdit|Write|WriteFile|ApplyPatch|apply_patch|FileChange)$/iu.test(detail.name ?? '')
  return h('details', {
    className: 'gb-execution-tool', open: expanded,
    'data-gb-execution-tool': event.id ?? '', 'data-status': status,
    'data-child': detail.parentId != null ? '' : undefined,
    onToggle: e => setExpanded(e.currentTarget.open),
  },
  h('summary', null,
    h('span', null, detail.name || event.id || '工具'),
    typeof toolTarget === 'string' && h('span', { className: 'gb-execution-meta' }, toolTarget),
    h('span', { className: 'gb-execution-state' }, statusLabel),
    outcome.length > 0 && h('span', { className: 'gb-execution-meta' }, outcome.join(' · '))),
  expanded && h('div', { className: 'gb-execution-body' },
    info.loading && !info.data && h('p', { role: 'status', className: 'gb-execution-note' }, '正在读取工具详情…'),
    info.error && h('p', { role: 'alert', className: 'gb-execution-error' }, '无法读取工具详情。', press('重试', info.reload)),
    detail.cwd && h(TraceField, { label: '工作目录', truncated: truncated('cwd') }, h(Code, { value: detail.cwd })),
    detail.locations != null && h(TraceField, { label: '位置', truncated: truncated('locations') },
      h(Code, { value: Array.isArray(detail.locations) ? locations.join('\n') : detail.locations })),
    h(TraceField, { label: '输入', truncated: truncated('input') }, h(Code, { value: detail.input, empty: '未记录工具输入' })),
    h(ToolOutput, { value: output, truncated: truncated('output') }),
    detail.error != null && h(TraceField, { label: '错误', truncated: truncated('error') }, h(Code, { value: detail.error })),
    changes && h(TraceField, { label: '文件变更', truncated: truncated('changes') }, detail.changes == null
      ? h('p', { className: 'gb-execution-note' }, '未记录文件差异')
      : h(FileChanges, { changes: detail.changes }))))
}

function Rows({ events, target, running, transcript = false }) {
  return h('div', { className: 'gb-execution-list' }, events.map((event, index) => {
    const key = event.type + ':' + (event.id ?? event.seq ?? index)
    if (event.type === 'tool') return h(ToolRow, { key, event, target, running })
    if (!transcript || !event.text) return null
    if (event.type === 'text') return h('div', { key, className: 'gb-execution-text' },
      h(MarkdownText, { text: event.text, labels: markdownLabels, variant: 'compact' }),
      event.truncatedFields?.includes('text') && h('p', { className: 'gb-execution-note' }, '记录超过保留上限，已截断。'))
    if (event.type === 'input') return h('details', { key, className: 'gb-execution-tool' },
      h('summary', null, '任务输入'), h('div', { className: 'gb-execution-body' }, h(Code, { value: event.text })))
    if (event.type === 'error') return h('p', { key, className: 'gb-execution-error', role: 'alert' }, event.text)
    return null
  }))
}

export function TurnExecution({ client, botId, sessionId, turn, running, legacy }) {
  const [choice, setExpanded] = useState(null)
  const expanded = choice ?? running
  useEffect(() => {
    if (running) setExpanded(was => was ?? true)
  }, [running])
  const viewId = useId()
  const view = useExecution(client, botId, sessionId, { turn, expanded, running, live: true })
  const events = view.data?.events ?? []
  const tools = events.filter(event => event.type === 'tool')
  if (!running && !legacy.length && !tools.length && !expanded) return null
  if (!running && !legacy.length && !tools.length && view.data) return null
  const legacyOnly = tools.length === 0 && legacy.length > 0
  return h('section', { className: 'gb-execution-turn', 'data-gb-delegated-activity': '', 'aria-label': '执行记录' },
    h('div', { className: 'gb-execution-controls' },
      press('执行记录' + (tools.length ? ' · ' + tools.length : ''), () => setExpanded(!expanded),
        { 'aria-expanded': expanded, 'aria-controls': viewId }),
      expanded && (view.error || !running) && press(view.error ? '重试' : '刷新', view.reload, { disabled: view.loading }),
      running && !tools.length && !legacy.length && h('span', { className: 'gb-execution-state' }, '运行中')),
    h('div', { id: viewId, hidden: !expanded && !legacyOnly },
      expanded && view.error && h('p', { className: 'gb-execution-error', role: 'alert' }, '暂时无法读取执行详情。'),
      expanded && view.loading && !view.data && !legacyOnly && h('p', { className: 'gb-execution-note', role: 'status' }, '正在读取…'),
      expanded && tools.length > 0 && h(Rows, { events: tools, target: { client, botId, sessionId, turn }, running: running || view.data?.running }),
      legacyOnly && h('div', { className: 'bt-agent-activity' }, legacy.map((step, index) => h('div', {
        key: index, className: 'bt-agent-act',
      }, h('span', { className: 'bt-agent-act-text' }, step))))))
}

function TurnHistory({ client, botId, sessionId, turn, running }) {
  const view = useExecution(client, botId, sessionId, { turn, running, live: true })
  const events = view.data?.events ?? []
  return h('div', { className: 'gb-execution-list' },
    view.error && h('p', { className: 'gb-execution-error', role: 'alert' }, '暂时无法读取执行记录。', press('重试', view.reload)),
    view.loading && !view.data && h('p', { className: 'gb-execution-note', role: 'status' }, '正在读取…'),
    view.data && !events.length && h('p', { className: 'gb-execution-note' }, '该回合没有可读取的执行记录。'),
    events.length > 0 && h(Rows, { events, target: { client, botId, sessionId, turn }, running: running || view.data?.running, transcript: true }))
}

function turnLabel(row) {
  const date = row.startedAt == null ? null : new Date(row.startedAt)
  const time = date && !Number.isNaN(+date) ? date.toLocaleString() : ''
  return [row.native ? '原生会话回合' : '回合 ' + row.turn, time, row.running && '运行中'].filter(Boolean).join(' · ')
}

function HistoryList({ client, botId, sessionId }) {
  const view = useExecution(client, botId, sessionId, { live: true })
  const [selected, select] = useState(null)
  const [older, setOlder] = useState(null)
  const [paging, setPaging] = useState(false)
  const [pagingError, setPagingError] = useState(false)
  const turns = view.data?.turns ?? []
  const listed = new Set(turns.map(row => row.turn))
  const rows = view.data ? [...turns, ...(older?.turns ?? []).filter(row => !listed.has(row.turn))] : []
  const cursor = view.data && (older ? older.cursor : view.data.cursor)
  async function more() {
    setPaging(true)
    setPagingError(false)
    try {
      const page = await client.dispatch({ action: 'execution.history', botId, sessionId, beforeTurn: cursor })
      setOlder(last => ({ ...page, turns: [...(last?.turns ?? []), ...(page.turns ?? [])] }))
    } catch { setPagingError(true) }
    finally { setPaging(false) }
  }
  return h('div', { className: 'gb-execution-list' },
    press('刷新', view.reload, { disabled: view.loading }),
    view.error && h('p', { className: 'gb-execution-error', role: 'alert' }, '暂时无法读取会话执行记录。'),
    view.loading && !view.data && h('p', { className: 'gb-execution-note', role: 'status' }, '正在读取…'),
    view.data && !rows.length && h('p', { className: 'gb-execution-note' }, '该会话暂无可读取的执行记录。'),
    ...rows.map(row => h('article', { key: row.turn, className: 'gb-execution-history-turn' },
      press(turnLabel(row), () => select(turn => turn === row.turn ? null : row.turn),
        { 'aria-expanded': selected === row.turn, 'data-gb-execution-turn-choice': '' }),
      selected === row.turn && h(TurnHistory, { client, botId, sessionId, turn: row.turn, running: row.running }))),
    cursor != null && press(pagingError ? '重新加载更早回合' : '加载更早回合', more, { disabled: paging }))
}

export function ExecutionHistory({ client, bot, sessionId, close }) {
  const current = bot.sessionId ?? bot.id
  const parts = [...new Set([current,
    ...(bot.openParts ?? []).flatMap(part => [part.sessionId, ...(part.parts ?? []).slice().reverse()]),
    ...(bot.parts ?? []).slice().reverse(),
  ])]
  const [selected, select] = useState(sessionId)
  const part = parts.includes(selected) ? selected : current
  return h('section', { className: 'bt-drawer-body gb-execution-pane', 'aria-label': '会话执行记录' },
    h('header', { className: 'gb-execution-header' },
      h('h3', null, '会话执行记录'), press(h(Icon, { name: 'close', size: 16 }), close, { 'aria-label': '关闭执行记录' })),
    parts.length > 1 && h('label', { className: 'gb-execution-controls' }, '会话',
      h('select', { className: 'gb-execution-select', value: part, onChange: e => select(e.target.value) },
        parts.map((id, index) => h('option', { key: id, value: id }, index === 0 ? '当前会话' : '其他会话 ' + index)))),
    h(HistoryList, { key: part, client, botId: bot.id, sessionId: part }))
}
