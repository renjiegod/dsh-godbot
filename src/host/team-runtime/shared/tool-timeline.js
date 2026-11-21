const activityPrefix = '▸ '
const referencePrefix = '\ttool='
const activityStatuses = new Map([
  ['调用', 'running'], ['完成', 'completed'], ['失败', 'failed'],
  ['已拒绝', 'declined'], ['已中断', 'interrupted'],
])

export function toolReference(line, id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 400
    ? line + referencePrefix + JSON.stringify(id) : line
}

export function readToolActivity(line) {
  if (!line.startsWith(activityPrefix)) return
  const [label, reference] = line.slice(activityPrefix.length).split(referencePrefix, 2)
  const parts = label.trim().split(' · ')
  const status = activityStatuses.get(parts.at(-1))
  if (status) parts.pop()
  const [name, ...target] = parts
  if (!name) return
  let id
  if (reference) {
    try {
      const value = JSON.parse(reference)
      if (typeof value === 'string' && value.length > 0 && value.length <= 400) id = value
    } catch {}
  }
  return { name, text: target.join(' · ') || undefined, status, id }
}

// Keep the first appearance of each referenced call. Older turns have only
// activity labels. Pair their starts and results where the label identifies
// an open call, preserving the start's position even for out-of-order results.
export function toolSlots(entries) {
  const slots = new Map()
  const seen = new Set()
  const pending = new Map()
  for (const [key, activity] of entries) {
    const { id, name, text, status } = activity
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    } else {
      const label = JSON.stringify([name, text])
      if (status === 'running') {
        const open = pending.get(label) ?? { starts: [], ambiguous: false }
        if (open.starts.length) open.ambiguous = true
        open.starts.push(key)
        pending.set(label, open)
      } else if (status && pending.has(label)) {
        const open = pending.get(label)
        const start = open.starts.shift()
        // Identical concurrent calls have no legacy ID. Leave their outcomes
        // to the receipts, whose first appearances are in call order.
        if (!open.ambiguous) slots.get(start).status = status
        if (!open.starts.length) pending.delete(label)
        continue
      }
    }
    slots.set(key, { ...activity })
  }
  return slots
}

// Bridge calls can have two receipts in older ACP turns, one from the native
// agent and one from DSH. Keep the actual host call when both sides agree.
const bridgeAlias = /^mcp(?:__godbot__|_godbot_)/u
export function mirroredTools(tools, hostIds) {
  const host = Map.groupBy(tools.filter(tool => hostIds.has(tool.id) && tool.id.startsWith('godbot-')), tool => tool.name)
  const aliases = tools.filter(tool => !hostIds.has(tool.id) && bridgeAlias.test(tool.name))
  const native = Map.groupBy(aliases, tool => tool.name.replace(bridgeAlias, ''))
  const mirrors = new Set()
  for (const [name, calls] of native) {
    const hostCalls = host.get(name)
    if (hostCalls?.length === calls.length && calls.every((call, index) => call.status === hostCalls[index].status))
      for (const call of calls) mirrors.add(call.id)
  }
  return mirrors
}

// IDs are authoritative. Legacy activity can acquire details when its tool
// name occurs equally often in the saved activity and unclaimed receipts.
export function bindToolSlots(slots, tools, hostIds = new Set(), mirrors = mirroredTools(tools, hostIds)) {
  const referenced = new Set(Array.from(slots.values(), ({ id }) => id).filter(Boolean))
  const byId = new Map(tools.map(tool => [tool.id, tool]))
  const names = Map.groupBy(Array.from(slots.values()).filter(slot => !slot.id), slot => slot.name)
  const candidates = Map.groupBy(tools.filter(tool => !hostIds.has(tool.id) && !referenced.has(tool.id)), tool => tool.name)
  const matched = new Map()
  for (const [name, sameName] of names) {
    const matches = candidates.get(name)
    if (matches?.length === sameName.length) sameName.forEach((slot, index) => matched.set(slot, matches[index].id))
  }
  const bound = new Map()
  for (const [key, slot] of slots) {
    const id = slot.id ?? matched.get(slot)
    if (!mirrors.has(id)) bound.set(key, { ...slot, ...byId.get(id), type: 'tool' })
  }
  return bound
}
