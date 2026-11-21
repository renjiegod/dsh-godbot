// Only explicit read-only reports have custom renderers. A model can mention
// the same headings or percentages in an ordinary answer.
const reports = new Set(['usage', 'stats', 'cost', 'context', 'config'])

export function claudeReportName(text) {
  if (typeof text !== 'string') return
  const value = text.trim().replace(/^\//u, '')
  return reports.has(value) ? value : undefined
}

export function isNativeReportCommand(agent, command) {
  return (agent === 'claude' || agent === 'local-claude-code') && !!claudeReportName(command)
}
