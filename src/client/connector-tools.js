import { createElement as h, useEffect, useState } from 'react'

const statusText = { ready: '已连接', connecting: '连接中', error: '连接失败', pending: '等待授权' }

export function ConnectorToolsPanel({ client, bot, sessionId }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let mounted = true, timer
    const update = async () => {
      try {
        const next = await client.dispatch({ action: 'connector.tools', botId: bot.id, sessionId })
        if (mounted) { setView(next); setError('') }
      } catch (cause) {
        if (mounted) { setView(null); setError(cause.message) }
      }
      if (mounted) timer = setTimeout(update, 3000)
    }
    void update()
    return () => { mounted = false; clearTimeout(timer) }
  }, [client, bot.id, sessionId, open])
  return h('details', { className: 'bt-drawer-model', onToggle: event => setOpen(event.currentTarget.open) },
    h('summary', { className: 'bt-section-title' }, '连接器工具'),
    error && h('p', { role: 'alert' }, error),
    open && !view && !error && h('p', { role: 'status' }, '正在读取工具目录…'),
    view && h('div', null,
      h('p', null, '后端 ', view.route || '等待选择模型'),
      !view.rows.length && h('p', null, '尚未连接应用。'),
      view.rows.map(connectorRow)))
}

function connectorRow(row) {
  const tools = row.tools.map(tool => {
    const state = tool.reason || (tool.listed ? '最近目录已列出' : '尚未在当前目录中观测到')
    const receipt = tool.result && h('small', null, ' · 最近调用', tool.result.error ? '失败' : '成功',
      ' ', new Date(tool.result.at).toLocaleTimeString())
    return h('li', { key: tool.name }, h('code', null, tool.name), ' · ', state, receipt)
  })
  return h('section', { key: row.id },
    h('strong', null, row.name, ' · ', !row.enabled ? '该成员已停用' : statusText[row.state] ?? row.state, row.readOnly ? ' · 只读' : ''),
    tools.length ? h('ul', null, tools) : h('p', null, '暂无已挂载工具。'))
}
