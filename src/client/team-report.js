import { isNativeReportCommand } from './report-command.js'

const routes = new Map([
  ['local-claude-code', 'claude'], ['local-codex-cli', 'codex'], ['local-antigravity', 'antigravity'],
])

function fromInput(text, source, provider, fallback) {
  if (typeof text !== 'string') return
  const name = /^\/([\w-]+)$/u.exec(text.trim())?.[1]
  if (!name) return
  const tag = /^godbot-slash:([^:]+):/u.exec(source?.rpcId ?? '')?.[1]
  if (tag && provider && tag !== provider) return
  const agent = routes.get(tag ?? provider ?? fallback)
  if (agent && isNativeReportCommand(agent, name)) return { agent, command: name }
}

function botProvider(bot) {
  return (bot?.model ?? bot?.appliedModel)?.split('/')[0]
}

export function turnReport(bot, step, users, steering, contexts) {
  if (!bot || step.status !== 'settled') return
  const end = step.finalNode?.seq
  let input
  for (const group of [users, steering, contexts]) {
    for (const node of group) {
      // Clock, memory, and other model context are injected between the user
      // input and its reply. Only a later worker/schedule can supersede the speaker.
      if (node.kind === 'context' && node.source?.kind !== 'bot' && node.source?.kind !== 'schedule') continue
      if (node.seq < end && (!input || node.seq > input.seq)) input = node
    }
  }
  if (input?.source?.kind !== 'user' || input.content?.length !== 1 || input.content[0].type !== 'text') return
  const recorded = step.finalNode?.requestConfig?.provider ?? step.finalNode?.providerMetadata?.provider
  // A tagged input remains attributable even when the Bot subsequently changes engines.
  const command = fromInput(input.content[0].text, input.source, recorded, botProvider(bot))
  return command && { ...command, seq: end, messageId: step.finalNode?.messageId }
}

// Earlier-parts projections keep turn/sequence numbers and plain text only.
// Work within one archived part at a time: turn numbers start over in each part.
export function earlierReports(items, bot) {
  if (!bot) return items
  let report, turn, matched
  return items.map(item => {
    if (item.kind === 'user') {
      turn = item.turn
      report = !item.images && !item.via && fromInput(item.text, undefined, 'local-claude-code')
      matched = undefined
    } else if (item.kind === 'bot' && report && Number.isInteger(turn) && item.turn === turn) {
      // These old projections dropped the historical route. A Bot can change
      // providers; its current model cannot identify an archived answer.
      const nativeHeader = report.command === 'context'
        ? /^## Context Usage\s/u.test(item.text) && /\*\*Model:\*\*\s+claude-/u.test(item.text)
        : /^You are currently using your subscription to power your Claude Code usage\b/iu.test(item.text)
      if (nativeHeader || (report.command === 'config' && /^Usage: \/config key=value/mu.test(item.text)))
        matched = { ...report, seq: item.seq, partId: item.sessionId }
      if (matched && Number.isInteger(item.seq) && item.seq === matched.seq) {
        return { ...item, nativeReport: matched }
      }
    } else if (item.kind !== 'bot') {
      report = undefined
    }
    return item
  })
}

// A turn can contain several assistant messages. Read the metadata from exactly
// the message we display, using that part's own materialized event window.
export function reportSessionUsage(entries, seq, messageId) {
  if (!Number.isInteger(seq) || !Array.isArray(entries)) return
  const entry = entries.findLast(item => item.type === 'event' && item.event.seq === seq)
  if (entry?.event.type !== 'assistant/message') return
  const message = entry.event.data?.message
  if (messageId && message?.id !== messageId || message?.source?.provider !== 'local-claude-code') return null
  return message.source.replayState?.response?.godbotClaudeSessionUsage
}
