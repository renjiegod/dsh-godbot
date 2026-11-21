export const originKinds = ['person', 'schedule', 'workflow', 'ci', 'webhook', 'github', 'handoff', 'service', 'unknown']
export const checkOnlyScheduleMarker = '[GODBOT CHECK-ONLY]\n'

export function runOrigin(kind, triggerId, actor = 'owner', readOnly = false) {
  return { kind, actor, ...(triggerId ? { triggerId } : {}), unattended: !['person', 'workflow'].includes(kind),
    ...(readOnly ? { readOnly: true } : {}) }
}

export function delegatedOrigin(parent, botId) {
  return {
    ...(parent ?? runOrigin('unknown')),
    kind: 'handoff',
    unattended: true,
    rootKind: parent?.rootKind ?? parent?.kind ?? 'unknown',
    delegatedBy: botId,
  }
}

export function mergeRunOrigins(current, incoming) {
  if (!current) return incoming
  if (!incoming || (current.readOnly && !incoming.readOnly)) return current
  if (incoming.readOnly && !current.readOnly) return incoming
  if (incoming.unattended && !current.unattended) return incoming
  return current
}
