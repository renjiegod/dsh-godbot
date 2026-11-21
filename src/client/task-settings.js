import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { TaskBoard, button, empty, row } from './controls.js'
import { pendingRequests } from './model.js'
import { UsageLimits } from './usage-limits.js'
import { AutomationAccess } from './automation-access.js'
import { NativeRoutines } from './native-routines.js'
import { Workflows } from './workflows.js'
import { PeopleAccess } from './people-access.js'

function useTaskSettings(client) {
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

export function TaskSettings({ client, actions, page, focus, readOnly: rosterReadOnly }) {
  const { data, run, refresh, pending, error, offline, clearError } = useTaskSettings(client)
  const workspace = data?.workspace
  const bots = data?.bots ?? []
  const readOnly = Boolean(rosterReadOnly || data?.readOnly)
  const showTask = taskId => actions.openSettings('tasks', { taskId })
  function openBot(bot) {
    actions.closeSettings()
    actions.openSession(bot.id)
  }
  return h('div', { className: 'gb-task-settings gb-stack' },
    row(button('刷新', refresh), !readOnly && button('统一创建自动化', () => actions.openSettings('automation', { kind: page === 'routines' ? 'task' : 'workflow' }))),
    offline && h('div', { className: 'gb-alert', role: 'status' }, '连接中断，正在重试 · ' + offline),
    error && h('div', { className: 'gb-alert', role: 'alert' }, h('span', null, error.message),
      row(button('重试原请求', error.retry), button('关闭', clearError))),
    !workspace ? empty('正在读取 Bot 团队…')
      : page === 'routines' ? h(NativeRoutines, { team: workspace, members: bots, client, run, readOnly,
        onTask: showTask, onWorkflowRun: (workflowId, workflowRunId) => actions.openSettings('tasks', { workflowId, workflowRunId }) })
      : page === 'limits' ? !readOnly && h(UsageLimits, { client, bots, models: data.dshModels ?? [] })
      : h('div', { className: 'gb-stack' },
        h(TaskBoard, { workspace, bots, tasks: data.tasks, run, pending, readOnly, focusTask: focus, openBot }),
        h(Workflows, { workspace, bots, tasks: data.tasks, client, refresh, readOnly,
          focusWorkflowId: focus?.workflowId, focusRunId: focus?.workflowRunId, onTask: showTask }),
        !readOnly && h(AutomationAccess, { client, team: workspace, members: bots }),
        !readOnly && h(PeopleAccess, { client, team: workspace })))
}
