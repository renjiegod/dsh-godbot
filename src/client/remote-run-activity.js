import { createElement as h, useEffect, useRef, useState } from 'react'
import { stamp } from './controls.js'

const labels = {
  submitted: '已提交', running: '远程执行中', finished: '已完成', failed: '远程执行结果待核对',
  disconnected: '已停止读取', 'tool-start': '调用工具', 'tool-end': '工具参数已发送', 'tool-result': '远端工具返回',
  'step-start': '开始步骤', 'step-end': '结束步骤',
}

export function RemoteRunActivity({ client, sessionId, live }) {
  // ExecutionHistory keys this component by the selected Session.
  const cursor = useRef()
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    let timer
    let disposed = false
    async function refresh() {
      let hasMore = false
      try {
        const page = await client.dispatch({ action: 'remote-agents.events', sessionId, after: cursor.current })
        if (disposed) return
        setError('')
        if (page.events.length) setEvents(current => [...current, ...page.events].slice(-120))
        cursor.current = page.cursor
        hasMore = page.events.length === 80
      } catch (failure) {
        if (!disposed && live) setError(failure.message)
      }
      if (!disposed && (hasMore || live)) timer = setTimeout(refresh, hasMore ? 0 : 1100)
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [client, sessionId, live])

  if (!events.length && !error) return null
  return h('details', { className: 'gb-execution-tool', open: true },
    h('summary', null, '远程 Agent 事件'),
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    h('ol', null, ...events.slice(-50).reverse().map(event => h('li', { key: event.seq },
      [stamp(event.time), labels[event.kind], event.tool, event.detail].filter(Boolean).join(' · ')))))
}
