const labels = { started: '调用', completed: '完成', failed: '失败', declined: '已拒绝', interrupted: '已中断' }

function display(value, limit) {
  return typeof value === 'string' ? value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, limit) : ''
}

export function commandLabel(value) {
  if (typeof value !== 'string') return
  const command = value.trim()
  // Keep conventional package tasks recognizable without retaining arbitrary arguments.
  const task = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|build|lint|typecheck)(?=\s|$)/u.exec(command)
  return task?.[0] ?? /^(?:[\w./\\:-]*[/\\])?([\w.-]+)(?=\s|$)/u.exec(command)?.[1]
}

// The Bot stream persists activity lines alongside the assistant message.
export function toolActivity(name, target, status) {
  const title = display(name, 160) || 'tool'
  const detail = display(target, 240)
  return {
    type: 'activity',
    text: `▸ ${title}${detail ? ` · ${detail}` : ''} · ${labels[status]}`,
  }
}
