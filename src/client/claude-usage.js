// Claude Code's headless CLI returns the Usage screen as text. Keep the original
// alongside the recognized sections so an added field or version-specific
// message can still be read verbatim.
const percentage = String.raw`\d+(?:\.\d+)?`
const quotaLabel = String.raw`Current\s+(?:session|week|day|month|hour)(?:\s*\([^()\n]{1,100}\))?`
const quotaStart = new RegExp(String.raw`\b(?=${quotaLabel}\s*:?\s*${percentage}%\s+used\b)`, 'giu')
const quotaRow = new RegExp(String.raw`^(${quotaLabel})\s*:?\s*(${percentage})%\s+used\b(.*)$`, 'iu')
const contributionHeading = /^what['’]s contributing to your usage\?/iu
const periodLabel = String.raw`Last\s+\d+\s*(?:hours?|days?|weeks?|months?|[hdwm])\b`
const periodStart = new RegExp(String.raw`\b(?=${periodLabel}\s*[·:])`, 'giu')
const periodRow = new RegExp(String.raw`^(${periodLabel})(?:\s*[·:]\s*(.*))?$`, 'iu')
const adviceStart = new RegExp(String.raw`(?:^|\s)(${percentage})%\s+(?=[\p{L}/])`, 'gu')
const rankRow = new RegExp(String.raw`^(.+?)\s+(${percentage})%$`, 'u')
const heading = /^You are currently using (?:your subscription|an? API key|API credits)\b/iu
const tableNames = { skills: 'Skills', subagents: 'Subagents', plugins: 'Plugins', sessions: 'Sessions' }

function recommendations(line, period, unknown, flattened = false) {
  // A well-formed native recommendation occupies one line. A percentage in its
  // description is part of the advice, not another row.
  const matches = [...line.matchAll(adviceStart)]
  if (!flattened) matches.splice(1)
  if (!matches.length) {
    unknown.push(line)
    return
  }
  const lead = line.slice(0, matches[0].index).trim()
  if (lead) unknown.push(lead)
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const body = line.slice(m.index + m[0].length, matches[i + 1]?.index).trim()
    const [label, ...detail] = body.split(/\s+·\s+/u)
    period.recommendations.push({ percent: Number(m[1]), label, detail: detail.join(' · ') })
  }
}

function tableValues(text, table, unknown) {
  // A ranked entry may itself contain commas, including a local directory name.
  // Only split after a complete percentage when the next entry begins.
  for (const part of text.split(/(?<=%)\s*,\s*/u).map(piece => piece.trim()).filter(Boolean)) {
    const row = rankRow.exec(part)
    if (row) table.items.push({ label: row[1], percent: Number(row[2]) })
    else if (/^\+\d+\s+more\b/iu.test(part)) table.more = part
    else unknown.push(part)
  }
}

export function parseClaudeUsage(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const text = raw.trim().replace(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/u, '$1')
    .replace(/\x1b\[[0-9;]*m/gu, '').trim()
  // Older history / copied CLI output may have lost line breaks. Only insert
  // boundaries at labels with an identifiable value or a known section heading.
  const lines = text
    .replace(quotaStart, '\n').replace(periodStart, '\n')
    .replace(/\b(?=What['’]s contributing to your usage\?|Approximate\s*·|Top (?:skills|subagents|plugins|sessions):)/giu, '\n')
    .split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (!lines.length || !(heading.test(lines[0]) || quotaRow.test(lines[0]) || contributionHeading.test(lines[0]))) return null
  const result = { raw, headline: '', quota: [], notes: [], periods: [], unparsed: [] }
  let period
  let table
  for (const line of lines) {
    const quota = quotaRow.exec(line)
    const window = periodRow.exec(line)
    const group = /^Top (skills|subagents|plugins|sessions):\s*(.*)$/iu.exec(line)
    if (quota && !period) {
      const tail = quota[3].replace(/^\s*[·,;—-]?\s*/u, '')
      const reset = /^resets\b/iu.test(tail) ? tail.replace(/^resets/iu, 'Resets') : ''
      result.quota.push({ label: quota[1], percent: Number(quota[2]), reset })
      if (tail && !reset) result.unparsed.push(tail)
    } else if (heading.test(line) && !period && !result.headline) {
      result.headline = line
    } else if (contributionHeading.test(line)) {
      const rest = line.replace(contributionHeading, '').trim()
      if (rest) result.notes.push(rest)
    } else if (/^Approximate\b/iu.test(line) && !period) {
      result.notes.push(line)
    } else if (window) {
      const rest = window[2] ?? ''
      const start = rest.search(/(?:^|\s)\d+(?:\.\d+)?%\s+(?=[\p{L}/])/u)
      period = { label: window[1], totals: (start < 0 ? rest : rest.slice(0, start)).trim(), recommendations: [], tables: [] }
      result.periods.push(period)
      table = undefined
      if (start >= 0) recommendations(rest.slice(start).trim(), period, result.unparsed, true)
    } else if (group && period) {
      table = { label: tableNames[group[1].toLowerCase()], items: [] }
      period.tables.push(table)
      tableValues(group[2], table, result.unparsed)
    } else if (period && /^Top [^:]+:/iu.test(line)) {
      table = undefined
      result.unparsed.push(line)
    } else if (period && table && (rankRow.test(line) || /^\+\d+ more$/iu.test(line))) {
      tableValues(line, table, result.unparsed)
    } else if (period && /^\d+(?:\.\d+)?%\s/u.test(line)) {
      recommendations(line, period, result.unparsed)
    } else if (!period && /^resets\b/iu.test(line) && result.quota.length && !result.quota.at(-1).reset) {
      result.quota.at(-1).reset = line
    } else {
      result.unparsed.push(line)
    }
  }
  return result.quota.length || result.periods.length ? result : null
}
