export const agentKinds = { dsh: 'dsh', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' }

export function textOf(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  return JSON.stringify(value, null, 2)
}

export function toolOutputText(event) {
  const format = output => !Array.isArray(output) ? textOf(output) : output.map((block) => {
    const content = block?.type === 'content' ? block.content : block
    if (content?.type === 'text' && typeof content.text === 'string') return content.text
    if (typeof content?.data === 'string' && typeof content.mimeType === 'string') return content.mimeType
    return textOf(content)
  }).filter(Boolean).join('\n')
  return [...new Set([format(event.output), format(event.content)].filter(Boolean))].join('\n')
}

export function sendModes(member) {
  const modes = [{ value: 'queue', label: member.activeTurnId ? '轮末排队' : '发送消息' }]
  if (member.activeTurnId && member.capabilities?.steer) modes.push({ value: 'steer', label: '本轮插话' })
  if (member.activeTurnId && member.capabilities?.interrupt)
    modes.push({ value: 'interrupt-send', label: '打断后发送' })
  return modes
}

export function timelineEntries(events) {
  const result = []
  for (const event of events) {
    const prev = result.at(-1)
    if (
      event.type === 'text' &&
      prev?.type === 'text' &&
      prev.turnId === event.turnId &&
      typeof prev.text === 'string' &&
      typeof event.text === 'string'
    ) {
      prev.text += event.text
    } else {
      result.push({ ...event })
    }
  }
  return result
}

export function optionsOf(options) {
  if (!Array.isArray(options)) return []
  return options
    .map((option) => {
      if (typeof option === 'string') return { value: option, label: option }
      const value = option.optionId ?? option.id ?? option.value ?? option.key ?? option.label
      return { value, label: option.name ?? option.label ?? option.title ?? String(value) }
    })
    .filter((option) => option.value != null)
}

const states = {
  queued: '已排队',
  pending: '待处理',
  dispatching: '投递中',
  sent: '已发送',
  accepted: '已接收',
  delivered: '已投递',
  starting: '启动中',
  preparing: '准备工作目录',
  'workspace-error': '工作目录准备失败',
  running: '运行中',
  idle: '空闲',
  stopping: '正在停止',
  stopped: '已停止',
  interrupted: '已打断',
  cancelled: '已取消',
  canceled: '已取消',
  failed: '失败',
  error: '出错',
  completed: '已完成',
  skipped: '已跳过',
  done: '已完成',
  succeeded: '已完成',
  blocked: '已阻塞',
  disconnected: '已断开',
  approved: '已通过',
  rejected: '未通过',
  unknown: '待核对',
  awaiting_review: '待验收',
  review: '待验收',
  assigned: '已分配',
  submitted: '待验收',
  open: '待处理',
  waiting: '等待中',
  answered: '已回答',
  written: '已写入',
  retained: '已保留',
  withdrawn: '已撤回',
  reported: '待验收',
  'awaiting-report': '等待成员报告',
  transferring: '正在移交',
  settled: '本轮已结束',
  'awaiting-stop': '等待停止',
  'awaiting-ack': '等待回执',
  working: '执行中',
  expired: '已失效',
  connecting: '正在连接',
  answering: '提交中',
  writing: '写入中',
  lost: '连接丢失',
  closed: '已关闭',
  resolved: '已处理',
  requires_action: '等待处理',
}
export const statusText = (status) => states[status] ?? status ?? '待就绪'
export const isPendingInteraction = (item) => !item.status || ['open', 'pending', 'waiting'].includes(item.status)

export function createClient(connection) {
  async function call(method, args, ...options) {
    const result = await connection.rpc.call('/api', `godbot/${method}`, { args }, ...options)
    if (!result.ok) throw new Error(`${result.error.code} · ${result.error.message}`)
    return result.value
  }
  return {
    terminalStatus: request => call('terminalStatus', { request }),
    terminalOpen: request => call('terminalOpen', { request }),
    terminalRead: (request, signal) => call('terminalRead', { request }, signal),
    terminalWrite: request => call('terminalWrite', { request }),
    terminalResize: request => call('terminalResize', { request }),
    terminalClose: request => call('terminalClose', { request }),
    snapshot: (options) => call('snapshot', options ?? {}),
    dispatch: (request) => call('dispatch', { request }),
    slashCommands: (target) => call('slashCommands', { target }),
    claudeReportSession: (target) => call('claudeReportSession', { target }),
    claudeStats: (target) => call('claudeStats', { target }),
    runSlash: (request) => call('dispatch', { request: { ...request, action: 'slash.run' } }),
  }
}

/** Only fingerprints and opaque IDs live in tab storage. Retrying a lost response reuses the host's receipt. */
export function pendingRequests(storage) {
  const local = new Map()
  async function keyFor(request) {
    const canonical = JSON.stringify(request, (_, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    )
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return (
      'dsh.godbot.request.v1.' +
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    )
  }
  return {
    async begin(request) {
      const key = await keyFor(request)
      let id = local.get(key)
      try {
        id ??= storage?.getItem(key)
      } catch {
        /* In-memory retries remain available. */
      }
      id ??= crypto.randomUUID()
      local.set(key, id)
      try {
        storage?.setItem(key, id)
      } catch {
        /* Storage is optional. */
      }
      return { key, id }
    },
    complete({ key, id }) {
      if (local.get(key) === id) local.delete(key)
      try {
        if (storage?.getItem(key) === id) storage.removeItem(key)
      } catch {
        /* Storage is optional. */
      }
    },
  }
}

export function taskGuard(task) {
  return { taskId: task.id, expectedOwnerId: task.ownerId, expectedRevision: task.revision }
}

export function nextEventCursor(snapshot) {
  return snapshot?.eventStreamId && Number.isSafeInteger(snapshot.lastEventSeq)
    ? { afterEventSeq: snapshot.lastEventSeq, eventStreamId: snapshot.eventStreamId }
    : undefined
}

export function mergeSnapshot(previous, received) {
  // Older hosts send complete snapshots without cursor metadata.
  if (received.eventAfter == null) return received
  if (
    !previous ||
    previous.eventStreamId !== received.eventStreamId ||
    previous.lastEventSeq !== received.eventAfter
  )
    return null
  return {
    ...received,
    events: received.events.length ? previous.events.concat(received.events) : previous.events,
  }
}

export function evidenceSummary(value, maximum = 95) {
  const full = textOf(value).trim()
  const flat = full.replace(/\s+/gu, ' ')
  return {
    full,
    summary: flat.length > maximum ? flat.slice(0, maximum).trimEnd() + '…' : flat,
    expandable: flat !== full || flat.length > maximum,
  }
}
