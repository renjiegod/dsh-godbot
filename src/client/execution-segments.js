// A turn's process as a panel shows it: what the Bot wrote, and each run of tool calls
// between its words as one group, the way its own chat folds them. `events` are the
// ordered rows `execution.history` answers for one turn.
export function processSegments(events) {
  const segments = []
  for (const [index, event] of (Array.isArray(events) ? events : []).entries()) {
    if (event?.type === 'tool') {
      const last = segments.at(-1)
      if (last?.type === 'tools') last.events.push(event)
      else segments.push({ type: 'tools', key: `tools:${event.id ?? event.seq ?? index}`, events: [event] })
    } else if (typeof event?.text === 'string' && event.text !== '') {
      segments.push({ type: event.type, key: `${event.type}:${event.seq ?? index}`, event })
    }
  }
  return segments
}

// How many of a run's calls have not ended yet.
export const runningCalls = events => events.filter(event => event.status === 'running' || event.status === 'pending').length
