import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from './chat-ui.js'
import { ChevronDownIcon, ChevronRightIcon } from './team-ui/icons.js'
import { t } from './team-ui/i18n.js'
import { observeToolGroups } from './tool-call-groups.js'
import { skillNameFromPath, toolKind } from '../host/team-runtime/shared/tool-kind.js'
import { ProcessIcon, processLabel } from './team-ui/process-activity.js'

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
.gb-execution-inline { align-self: stretch; min-width: 0; margin: 4px 0; color: var(--bt-ink); font-size: 13px; line-height: 1.45; }
.gb-execution-inline > [hidden],
:is([data-chat-flow-kind=tool-call], [data-chat-flow-kind=assistant-step]):has(> [data-slot="conversation.chat.node"] > .gb-execution-inline[hidden]:only-child) { display: none !important; }
.gb-tool-group.gb-execution-button { display: flex; width: 100%; align-items: center; gap: 6px; text-align: start; }
.gb-tool-group > svg { flex: none; }
.gb-tool-group .gb-tool-group-failed { color: var(--bt-danger); }
.gb-execution-list { display: grid; gap: 5px; min-width: 0; }
.gb-execution-button { min-height: 28px; padding: 3px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--bt-ink-2); font: inherit; cursor: pointer; }
.gb-execution-button:hover, .gb-execution-button[aria-pressed=true] { background: var(--bt-hover); color: var(--bt-ink); }
.gb-execution-button:focus-visible, .gb-execution-tool > summary:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 1px; }
.gb-execution-tool { min-width: 0; border: 1px solid var(--bt-line); border-radius: 8px; }
.gb-execution-tool[data-child] { margin-inline-start: 12px; }
.gb-execution-tool > summary, .gb-execution-legacy { padding: 5px 8px; }
.gb-execution-tool > summary { cursor: pointer; }
:is(.gb-execution-tool > summary, .gb-execution-legacy) > span { margin-inline-end: 8px; overflow-wrap: anywhere; }
:is(.gb-execution-tool > summary, .gb-execution-legacy) > span:last-child { margin-inline-end: 0; }
.gb-execution-state, .gb-execution-meta, .gb-execution-note { color: var(--bt-ink-2); font-size: 12px; }
.gb-execution-tool[data-status=failed] .gb-execution-state, .gb-execution-error { color: var(--bt-danger); }
.gb-execution-action { display: inline-flex; align-items: center; gap: 5px; color: var(--bt-ink-2); }
.gb-execution-action > svg { flex: none; width: 14px; height: 14px; }
.gb-execution-body { display: grid; gap: 8px; padding: 6px 8px 9px; border-top: 1px solid var(--bt-line); min-width: 0; }
.gb-execution-body h4 { margin: 0 0 3px; font-size: 12px; }
.gb-execution-code { max-height: 14rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; box-sizing: border-box; margin: 0; padding: 6px 8px; border-radius: 6px; background: var(--bt-hover); font: 12px/1.5 ui-monospace, monospace; }
.gb-execution-code [data-diff=add] { color: var(--bt-green, #177246); }
.gb-execution-code [data-diff=remove] { color: var(--bt-danger); }
.gb-execution-note, .gb-execution-error { margin: 3px 0; overflow-wrap: anywhere; }
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

// A turn can render tools in several assistant and host-tool cells. Share the
// lightweight status poll across all of them and load full receipts on demand.
const emptyTools = []
const emptyToolStore = { read: () => emptyTools, subscribe: () => () => {} }
const toolStores = new WeakMap()

export function useExecutionTools(client, botId, sessionId, turn, enabled) {
  const key = JSON.stringify([botId, sessionId, turn])
  const store = useMemo(() => {
    if (!enabled) return emptyToolStore
    let turns = toolStores.get(client)
    if (!turns) toolStores.set(client, turns = new Map())
    if (turns.has(key)) return turns.get(key)
    let events = emptyTools, timer, loading = false, failures = 0
    const listeners = new Set()
    const load = async () => {
      if (loading) return
      loading = true
      try {
        const data = await client.dispatch({ action: 'execution.history', botId, sessionId, turn, onlyTools: true })
        failures = 0
        events = data.events ?? emptyTools
        for (const notify of listeners) notify()
        if (data.running && listeners.size) timer = setTimeout(load, 700)
      } catch {
        if (++failures < 3 && listeners.size) timer = setTimeout(load, 1400)
      } finally {
        loading = false
      }
    }
    const view = {
      read: () => events,
      subscribe(notify) {
        listeners.add(notify)
        turns.set(key, view)
        if (listeners.size === 1) void load()
        return () => {
          listeners.delete(notify)
          if (listeners.size) return
          clearTimeout(timer)
          if (turns.get(key) === view) turns.delete(key)
        }
      },
    }
    turns.set(key, view)
    return view
  }, [client, key, enabled])
  return useSyncExternalStore(store.subscribe, store.read)
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

function ToolRow({ event, target, running, visible }) {
  const [expanded, setExpanded] = useState(false)
  const { client, botId, sessionId, turn } = target
  const live = running && (event.status === 'running' || event.status === 'pending')
  const fetchable = typeof event.id === 'string' && event.id !== ''
  const readDetail = visible && fetchable && expanded
  const info = useExecution(client, botId, sessionId, { turn, toolId: event.id, expanded: readDetail,
    running: readDetail && live })
  const detail = { ...event, ...info.data?.events?.[0] }
  const status = event.status ?? detail.status
  const statusLabel = !running && (status === 'running' || status === 'pending')
    ? '终态未记录' : labels[status] ?? '状态未报告'
  const targetText = targetOf(detail)
  const activityKind = detail.activityKind ?? toolKind(detail.name, targetText)
  const skill = detail.input?.skill ?? detail.input?.name ?? skillNameFromPath(targetText)
  const toolTarget = activityKind === 'skill' ? skill ?? targetText : targetText
  const locations = Array.isArray(detail.locations) ? detail.locations.map(locationText).filter(Boolean) : []
  const truncated = key => detail.truncatedFields?.includes(key)
  const outcome = [
    typeof detail.exitCode === 'number' && '退出码 ' + detail.exitCode,
    Number.isFinite(detail.durationMs) && (detail.durationMs < 1000
      ? detail.durationMs + ' 毫秒' : (detail.durationMs / 1000).toFixed(1) + ' 秒'),
  ].filter(Boolean)
  const output = detail.output ?? detail.outputDelta
  const changes = detail.changes != null || /^(?:Edit|MultiEdit|Write|WriteFile|ApplyPatch|apply_patch|FileChange)$/iu.test(detail.name ?? '')
  const heading = [
    h('span', { key: 'action', className: 'gb-execution-action' }, h(ProcessIcon, { kind: activityKind }), processLabel(activityKind)),
    h('span', { key: 'name', className: 'gb-execution-name' }, detail.name || event.id || '工具'),
    typeof toolTarget === 'string' && h('span', { key: 'target', className: 'gb-execution-meta gb-execution-target', title: toolTarget }, toolTarget),
    h('span', { key: 'status', className: 'gb-execution-state' }, statusLabel),
    outcome.length > 0 && h('span', { key: 'outcome', className: 'gb-execution-meta' }, outcome.join(' · ')),
  ]
  const attributes = { className: 'gb-execution-tool', 'data-status': status, 'data-gb-tool-kind': activityKind ?? 'tool' }
  if (!fetchable) return h('div', { ...attributes, className: 'gb-execution-tool gb-execution-legacy' }, heading)
  return h('details', {
    ...attributes, open: expanded,
    'data-gb-execution-tool': event.id ?? '',
    'data-child': detail.parentId != null ? '' : undefined,
    onToggle: e => setExpanded(e.currentTarget.open),
  },
  h('summary', { title: detail.name }, heading),
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

function Rows({ events, target, running, transcript = false, visible = true }) {
  return h('div', { className: 'gb-execution-list', hidden: !visible }, events.map((event, index) => {
    const key = event.type + ':' + (event.id ?? event.seq ?? index)
    if (event.type === 'tool') return h(ToolRow, { key, event, target, running, visible })
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

export function InlineExecution({ client, botId, sessionId, turn, running, events }) {
  const root = useRef(null)
  const disclosure = useRef(null)
  const [group, setGroup] = useState(null)
  useLayoutEffect(() => {
    const binding = observeToolGroups(root.current, turn, setGroup)
    disclosure.current = binding
    return () => binding?.dispose()
  }, [sessionId, turn])

  const inProgress = running ? events.filter(event => event.status === 'running' || event.status === 'pending').length : 0
  const failed = events.filter(event => event.status === 'failed').length
  const visible = !group || group.open === true
  return h('div', { ref: root, className: 'gb-execution-inline', hidden: group?.concealed,
    'data-gb-tool-count': events.length, 'data-gb-tool-running': inProgress, 'data-gb-tool-failed': failed },
  group?.count && h('button', { type: 'button', className: 'gb-execution-button gb-tool-group', 'aria-expanded': group.open,
    'data-gb-tool-group': '', onClick: event => {
      event.currentTarget.focus({ preventScroll: true })
      disclosure.current?.toggle()
    } },
  h(group.open ? ChevronDownIcon : ChevronRightIcon),
  h('span', null, t('{count} tool calls', { count: group.count })),
  group.running > 0 && h('span', { className: 'gb-execution-meta' }, t('{count} running', { count: group.running })),
  group.failed > 0 && h('span', { className: 'gb-execution-meta gb-tool-group-failed' }, t('{count} failed', { count: group.failed }))),
  h(Rows, { events, target: { client, botId, sessionId, turn }, running, visible }))
}
