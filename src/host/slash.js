// Only an owner submission explicitly selected in the command composer crosses the
// team adapter as a native command. A slash in history, a group relay or tool output
// remains ordinary content.
export function parseSlash(text) {
  if (typeof text !== 'string') return null
  const match = /^([/$])([\p{L}\p{N}][\p{L}\p{N}_.:-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim())
  return match && { prefix: match[1], name: match[2], args: match[3] ?? '' }
}

export function resolveSlash(rows, name, args = '') {
  if (typeof args !== 'string') throw new Error('Invalid command arguments')
  const row = rows.find(item => item.name === name)
  if (!row) throw new Error('当前 Agent 或工作目录未提供这条命令，请重新选择。')
  if (row.kind === 'terminal') throw new Error('此命令需要在原生终端或对应的工作台设置中使用。')
  const text = (row.insertText ?? '/' + row.name) + (args.trim() ? ' ' + args.trim() : '')
  return { name: row.name, text, ...(row.skillPath ? { skillPath: row.skillPath } : {}),
    ...(row.kind === 'protocol' ? { protocol: true, args: args.trim() } : {}) }
}

export function slashInput(command, text = command.text) {
  if (command.protocol) return [{ type: 'native-command', name: command.name, args: command.args }]
  if (!command.skillPath) return command.text
  const parts = typeof text === 'string' ? [{ type: 'text', text }] : text
  return [...parts, { type: 'skill', name: command.name, path: command.skillPath }]
}

export const teamSlashPrefix = 'godbot-slash:'
export function teamSlashMessage(messages) {
  const latest = messages?.findLast(message => {
    if (message.role === 'system') return false
    if (message.role !== 'user') return true
    const source = message.source
    // DSH retains clock and memory snapshots *after* the queued owner input.
    // A relay, another user, or a tool result must still supersede it.
    return source?.kind !== 'runtime-context' && source?.kind !== 'time-context' &&
      !(['snapshot', 'instructions', 'catalog', 'recall'].includes(source?.form) &&
        !['user', 'bot', 'schedule'].includes(source?.kind))
  })
  if (latest?.role !== 'user' || latest.source?.kind !== 'user' || !latest.source.rpcId?.startsWith(teamSlashPrefix)) return
  const parts = latest.content
  if (parts?.length !== 1 || parts[0]?.type !== 'text') return
  const parsed = parseSlash(parts[0].text)
  if (!parsed) throw new Error('Invalid native command')
  return { ...parsed, route: latest.source.rpcId.slice(teamSlashPrefix.length).split(':')[0], messageId: latest.id }
}
