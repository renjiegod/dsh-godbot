import { UsagePolicy as BotUsagePolicy } from '../../src/host/usage-policy.js'
import { baseRoutes } from '../../src/host/team-runtime/sandbox-agents.js'

const nativeRoutes = { ...baseRoutes, acp: 'local-acp' }

// Persist the launch environment on the turn before a settings change is possible.
export function nativeUsageBinding(member) {
  if (!Object.hasOwn(nativeRoutes, member.kind)) return
  const model = member.nativeSettings?.model || member.nativeOptions?.currentModel
  return { route: nativeRoutes[member.kind], accountId: member.accountProfileId ?? null, ...(model ? { model } : {}) }
}

export class UsagePolicy extends BotUsagePolicy {
  owner(id) {
    return super.owner(id) ?? this.store.all('members').find(member => member.kind === 'dsh' && member.nativeId === id)?.id
  }
  configure(subject, inputs) {
    const member = this.store.get('members', subject)
    if (inputs.backup && member && member.kind !== 'dsh') throw new Error('自动接管需要 API 模型。')
    return super.configure(subject, inputs)
  }

  native(member, turn, event) {
    if (!event.usage || !event.usageId) return
    const u = event.usage
    const id = 'native:' + turn.id + '/' + event.usageId
    const previous = this.store.get('usageReceipts', id)
    const count = (key) => typeof u[key] === 'number' && Number.isFinite(u[key]) && u[key] >= 0
    if (!['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(count)) return
    this.store.put('usageReceipts', {
      id,
      owner: member.id,
      time: previous?.time ?? this.clock(),
      hostTurnId: turn.id,
      provider: member.kind,
      usageBinding: previous?.usageBinding ?? turn.usageBinding,
      model: event.model || previous?.model || turn.usageBinding?.model ||
        (turn.usageBinding ? 'default' : member.nativeSettings?.model || member.nativeOptions?.currentModel || 'default'),
      input: count('inputTokens') ? u.inputTokens : 0,
      output: count('outputTokens') ? u.outputTokens : 0,
      cacheRead: count('cacheReadTokens') ? u.cacheReadTokens : 0,
      cacheWrite: count('cacheWriteTokens') ? u.cacheWriteTokens : 0,
    })
  }

  finishNative(member, turn) {
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE collection='usageReceipts' AND json_extract(data,'$.hostTurnId')=? LIMIT 1",
        )
        .get(turn.id)
    )
      return
    this.store.put('usageReceipts', {
      id: 'missing:' + turn.id,
      owner: member.id,
      hostTurnId: turn.id,
      provider: member.kind,
      usageBinding: turn.usageBinding,
      model: turn.usageBinding?.model,
      time: this.clock(),
      missing: true,
    })
  }

}
