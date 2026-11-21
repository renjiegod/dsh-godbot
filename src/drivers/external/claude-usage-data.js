// Allowlisted projection shared by the live Claude command and its local stats
// cache. Neither the server's account attributes nor CLI session IDs belong in
// these display fields. The SDK may add fields between releases.
export function claudeCounts(source, fields) {
  const result = {}
  for (const [key, field] of Object.entries(fields)) {
    const value = source?.[field]
    if (Number.isSafeInteger(value) && value >= 0) result[key] = value
  }
  return result
}

function validModel(name) {
  // Native model IDs may have one provider namespace, e.g. anthropic/claude-opus-5.5.
  return /^(?:[a-z0-9][a-z0-9._-]{0,48}\/)?[a-zA-Z0-9][\w:.-]{0,144}$/u.test(name) &&
    !name.includes('..') && !/(?:^|\/)sk-(?:ant-)?[a-z\d_-]{12,}/iu.test(name) &&
    !/(?:^|\/)[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(name)
}

function validCost(value) {
  return Number.isFinite(value) && value >= 0
}

export function projectClaudeModels(source, { includeCost = false } = {}) {
  const models = []
  if (!source || typeof source !== 'object' || Array.isArray(source)) return models
  for (const [name, row] of Object.entries(source)) {
    if (!validModel(name)) continue
    const values = claudeCounts(row, {
      inputTokens: 'inputTokens', outputTokens: 'outputTokens',
      cacheReadTokens: 'cacheReadInputTokens', cacheCreationTokens: 'cacheCreationInputTokens',
    })
    if (includeCost && validCost(row?.costUSD)) values.costUsd = row.costUSD
    if (Object.keys(values).length) models.push({ name, ...values })
  }
  return models
}

// SDKAssistantMessage.usage_report and get_usage share this session shape.
// A missing twin on a historical result is distinct from a measured zero.
export function projectClaudeSessionUsage(report) {
  const session = report?.session
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const totals = claudeCounts(session, {
    apiDurationMs: 'total_api_duration_ms', durationMs: 'total_duration_ms',
    linesAdded: 'total_lines_added', linesRemoved: 'total_lines_removed',
  })
  if (validCost(session.total_cost_usd)) totals.totalCostUsd = session.total_cost_usd
  const models = projectClaudeModels(session.model_usage, { includeCost: true })
  if (!Object.keys(totals).length && !models.length) return null
  return { ...totals, models }
}

// Accept only the command's own synthetic assistant response. This field
// belongs to the native frame, never to user text or a model's tool output.
export function claudeUsageFrame(event) {
  if (event?.type !== 'assistant' || event.parent_tool_use_id != null ||
      event.message?.model !== '<synthetic>' || event.local_command_run?.command !== 'usage') return
  const content = event.message.content
  if (content?.length !== 1 || content[0].type !== 'text' || typeof content[0].text !== 'string') return
  const sessionUsage = projectClaudeSessionUsage(event.usage_report)
  if (sessionUsage) return { text: content[0].text, sessionUsage }
}
