import { createElement as h, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { TaskBoard, button, empty, row } from './controls.js'
import { Pop, iconButton } from './chat-ui.js'
import { pendingRequests } from './model.js'
import { WorkspaceSidebar } from './workspace-sidebar-view.js'
import { UsageLimits } from './usage-limits.js'
import { AutomationAccess } from './automation-access.js'
import { NativeRoutines } from './native-routines.js'
import { Workflows } from './workflows.js'
import { PeopleAccess } from './people-access.js'
import { styles } from './styles.js'

function useWorkbench(client) {
  const [data, setData] = useState(null)
  const [offline, setOffline] = useState('')
  const [error, setError] = useState(null)
  const [ledger] = useState(() => {
    try {
      return pendingRequests(window.sessionStorage)
    } catch {
      return pendingRequests()
    }
  })
  const [busy, setBusy] = useState([])
  const generation = useRef(0)
  const pending = useRef(new Set())
  const mounted = useRef(false)
  const refresh = useCallback(async () => {
    const token = ++generation.current
    try {
      const view = await client.dispatch({ action: 'team-workspace.management' })
      if (!view?.workspace?.id || !Array.isArray(view.bots) || !Array.isArray(view.tasks))
        throw new Error('尚未取得 Bot 团队的任务板。')
      if (mounted.current && token === generation.current) {
        setData(view)
        setOffline('')
      }
    } catch (cause) {
      if (mounted.current && token === generation.current) setOffline(cause.message || String(cause))
    }
  }, [client])
  useEffect(() => {
    mounted.current = true
    let timer
    let stopped = false
    const poll = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(poll, document.hidden ? 8000 : 1300)
    }
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    void poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      mounted.current = false
      stopped = true
      generation.current++
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])
  const run = async (request, applied) => {
    const key = `${request.action}/${request.taskId ?? request.id ?? request.ownerId ?? ''}`
    if (pending.current.has(key)) return { ok: false }
    pending.current.add(key)
    setBusy([...pending.current])
    setError(null)
    let value
    try {
      const ticket = await ledger.begin(request)
      value = await client.dispatch({ ...request, requestId: ticket.id })
      ledger.complete(ticket)
    } catch (cause) {
      if (mounted.current)
        setError({ message: cause.message || String(cause), retry: () => run(request, applied) })
      return { ok: false }
    } finally {
      if (mounted.current) await refresh()
      pending.current.delete(key)
      if (mounted.current) setBusy([...pending.current])
    }
    if (mounted.current) applied?.(value)
    return { ok: true, value }
  }
  return {
    data,
    refresh,
    run,
    offline,
    error,
    clearError: () => setError(null),
    pending: busy.length > 0,
  }
}

export function Workbench({ client, navigation }) {
  const sidebar = useSyncExternalStore(navigation.subscribeSidebar, navigation.getSidebar, navigation.getSidebar)
  const { data, run, refresh, pending, error, offline, clearError } = useWorkbench(client)
  const [page, setPage] = useState('tasks')
  const [focus, setFocus] = useState({})
  const heading = useRef(null)
  const go = (next, item = {}) => {
    setFocus(item)
    setPage(next)
    const current = navigation.getSidebar()
    if (current?.drawer && !current.collapsed) {
      navigation.toggleSidebar()
      heading.current?.focus({ preventScroll: true })
    }
  }
  const showTask = taskId => {
    go('tasks', { taskId })
    document.getElementById('gb-task-' + taskId)?.focus()
  }
  const openSettings = settings => navigation.openBot({ settings })
  const showNav = !sidebar?.node || sidebar.drawer || (sidebar.collapsed && document.documentElement.dataset.platform === 'darwin')
  const workspace = data?.workspace
  const bots = data?.bots ?? []
  const readOnly = Boolean(data?.readOnly)
  const title = page === 'routines' ? '自动化任务' : '团队管理'
  return h('div', { className: 'gb-root gb-workspace', 'data-godbot': 'workbench' },
    h('style', null, styles),
    sidebar?.node && createPortal(h(WorkspaceSidebar, { client, sidebar, navigation, page, go, openSettings }), sidebar.node),
    h('main', { className: 'gb-pane', 'aria-label': '团队管理' },
      h('header', { className: 'gb-chat-header' },
        h('div', { className: 'gb-header-start' },
          showNav && iconButton('展开侧栏', 'panel', navigation.toggleSidebar),
          showNav && iconButton('返回 dsh', 'back', navigation.back)),
        h('h1', { ref: heading, tabIndex: -1 }, title),
        h('div', { className: 'gb-header-end' },
          h(Pop, { label: '管理操作', icon: 'more' },
            button('任务板', () => go('tasks')),
            button('自动化任务', () => go('routines')),
            button('Bot 设置', () => openSettings('bots')),
            button('群聊设置', () => openSettings('groups')),
            button('会话定时消息', () => openSettings('schedules')),
            button('本地 Agent 设置', () => openSettings('local-agents')),
            button('刷新', refresh)))),
      offline && h('div', { className: 'gb-alert', role: 'status' }, '连接中断，正在重试 · ' + offline),
      error && h('div', { className: 'gb-alert', role: 'alert' }, h('span', null, error.message),
        row(button('重试原请求', error.retry), button('关闭', clearError))),
      !workspace ? h('section', { className: 'gb-page' }, empty('正在读取 Bot 团队…'))
        : page === 'routines' ? h(NativeRoutines, { team: workspace, members: bots, client, run, readOnly,
          onTask: showTask, onWorkflowRun: (workflowId, workflowRunId) => go('tasks', { workflowId, workflowRunId }) })
        : h('section', { className: 'gb-page gb-stack' },
          h(TaskBoard, { workspace, bots, tasks: data.tasks, run, pending, readOnly, focusTaskId: focus.taskId,
            openBot: bot => navigation.openBot(bot.id) }),
          h(Workflows, { workspace, bots, tasks: data.tasks, client, refresh, readOnly,
            focusWorkflowId: focus.workflowId, focusRunId: focus.workflowRunId, onTask: showTask }),
          !readOnly && h(AutomationAccess, { client, team: workspace, members: bots }),
          !readOnly && h(PeopleAccess, { client, team: workspace }),
          !readOnly && h(UsageLimits, { client, bots, models: data.dshModels ?? [] }))))
}
