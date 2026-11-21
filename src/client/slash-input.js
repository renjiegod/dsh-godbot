// A command is completed only while the entire draft is its first slash word.
// Once the user starts an argument, Enter belongs to the normal submit handler.
export function slashQuery(text) {
  return typeof text === 'string' ? (/^\/([^\s/]*)$/u.exec(text)?.[1] ?? null) : null
}

export function parseSlashInvocation(text) {
  const match = typeof text === 'string' && /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text.trim())
  return match ? { name: match[1], args: match[2] ?? '' } : null
}

export function matchCommandInvocation(commands, text) {
  const parsed = parseSlashInvocation(text)
  if (parsed) {
    const command = commands.find((item) => item.name === parsed.name)
    return command && { command, args: parsed.args }
  }
  const skill = /^\$([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text.trim())
  if (!skill) return
  const command = commands.find(
    (item) => item.kind === 'skill' && (item.insertText?.trim() === '$' + skill[1] || item.name === skill[1]),
  )
  return command && { command, args: skill[2] ?? '' }
}

export function matchingCommands(commands, query, kind) {
  if (query === null) return []
  const prefix = query.toLowerCase()
  return commands.filter(
    (command) => (!kind || command.kind === kind) && command.name.toLowerCase().startsWith(prefix),
  )
}

// The highlighted row survives only while the menu still shows the same list.
// A team conversation has no command scope, so a missing cursor never matches.
export function selectedIndex(cursor, { scope, query, kind }, count) {
  if (!cursor || cursor.scope !== scope || cursor.query !== query || cursor.kind !== kind) return 0
  return Math.min(cursor.index, count - 1)
}

export function completionFor(command) {
  return (command.insertText || '/' + command.name).trimEnd() + ' '
}

export function slashKeyIntent(event, { open, count, loading, exact }) {
  if (
    !open ||
    event.isComposing ||
    event.nativeEvent?.isComposing ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return null
  if (event.key === 'Escape') return 'dismiss'
  if (!count) return loading && event.key === 'Enter' ? 'wait' : null
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'previous'
  if (event.key === 'Tab' || (event.key === 'Enter' && !exact)) return 'pick'
  return null
}

export function terminalAction(name) {
  if (name === 'model' || name === 'effort') return 'settings'
  if (name === 'status') return 'status'
  if (name === 'skills') return 'skills'
  if (name === 'help') return 'commands'
}
