import { createElement as h, useEffect, useRef, useState } from 'react'

const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })
const activity = [['messages', 'Messages'], ['sessions', 'Sessions'], ['toolCalls', 'Tool calls']]
const tokens = [['inputTokens', 'Input'], ['outputTokens', 'Output'], ['cacheReadTokens', 'Cache read'], ['cacheCreationTokens', 'Cache write']]
const errors = {
  missing: '这台机器上还没有 Claude Code 的 Stats 缓存。',
  unsupported: '当前版本的 Claude Code 统计缓存格式暂不支持。',
  empty: 'Claude Code 的统计缓存中还没有活动记录。',
  unreadable: '暂时无法读取这台机器上的 Claude Code 统计。',
}

function StatsTable({ title, rows, rowKey, rowLabel, columns }) {
  const present = columns.filter(([key]) => rows.some(row => Number.isFinite(row[key])))
  if (!rows.length || !present.length) return null
  return h('section', { className: 'gb-stats-table-section' },
    h('h4', null, title),
    h('div', { className: 'gb-stats-table-scroll', role: 'region', 'aria-label': title, tabIndex: 0 },
      h('table', { className: 'gb-stats-table', 'aria-label': title, 'data-stats-models': rowKey === 'name' || undefined },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, rowLabel),
          present.map(([key, label]) => h('th', { key, scope: 'col' }, label)))),
        h('tbody', null, rows.map(row => h('tr', { key: row[rowKey] },
          h('th', { scope: 'row' }, row[rowKey]),
          present.map(([key, label]) => h('td', { key, 'data-label': label }, Number.isFinite(row[key]) ? (key === 'costUsd' ? dollars : format).format(row[key]) : '—'))))))),
  )
}

function duration(ms) {
  const minutes = Math.floor(ms / 60_000)
  if (ms < 1000) return ms + ' ms'
  if (minutes < 1) return (ms / 1000) + ' s'
  const seconds = Math.floor(ms / 1000) % 60
  return minutes < 60 ? minutes + 'm ' + seconds + 's' : Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm'
}

function MetricList({ metrics }) {
  const visible = metrics.filter(([, value]) => value != null)
  if (!visible.length) return null
  return h('dl', { className: 'gb-stats-metrics' },
    visible.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value))))
}

export function ClaudeSessionUsage({ session }) {
  const metrics = [
    ['API time', Number.isFinite(session.apiDurationMs) ? duration(session.apiDurationMs) : null],
    ['Session time', Number.isFinite(session.durationMs) ? duration(session.durationMs) : null],
    ['Lines added', Number.isFinite(session.linesAdded) ? '+' + format.format(session.linesAdded) : null],
    ['Lines removed', Number.isFinite(session.linesRemoved) ? '−' + format.format(session.linesRemoved) : null],
    ['API-equivalent cost', Number.isFinite(session.totalCostUsd) ? dollars.format(session.totalCostUsd) : null],
  ]
  return h('details', { className: 'gb-usage-session' },
    h('summary', null, 'Session'),
    h(MetricList, { metrics }),
    h(StatsTable, { title: 'Model usage · this session', rows: session.models ?? [], rowKey: 'name',
      rowLabel: 'Model', columns: [...tokens, ['costUsd', 'USD']] }))
}

function StatsContents({ data }) {
  const [days, setDays] = useState(7)
  const cutoff = Date.parse(data.asOf + 'T00:00:00Z') - (days - 1) * 86_400_000
  const from = new Date(cutoff).toISOString().slice(0, 10)
  const daily = data.daily.filter(row => row.date <= data.asOf && (days === 0 || row.date >= from))
    .sort((a, b) => b.date.localeCompare(a.date))
  // Claude's activity Stats includes both input/output and both cache token
  // classes. Only aggregate a complete model cache, preserving missing values.
  const hasBreakdown = data.models.length > 0 && data.models.every(row => tokens.every(([key]) => Number.isFinite(row[key])))
  const totalTokens = hasBreakdown ? data.models.reduce((sum, row) => tokens.reduce((n, [key]) => n + row[key], sum), 0) : null
  const metrics = [
    ['Total tokens · incl. cache', Number.isSafeInteger(totalTokens) ? h('abbr', { title: format.format(totalTokens) }, compact.format(totalTokens)) : null],
    ['Total sessions', Number.isFinite(data.totals.sessions) ? format.format(data.totals.sessions) : null],
    ['Total messages', Number.isFinite(data.totals.messages) ? format.format(data.totals.messages) : null],
    ['First session', data.firstSessionDate],
    ['Longest session', [
      Number.isFinite(data.longest?.durationMs) ? duration(data.longest.durationMs) : '',
      Number.isFinite(data.longest?.messages) ? format.format(data.longest.messages) + ' messages' : '',
    ].filter(Boolean).join(' · ') || null],
  ]
  return h('div', { className: 'gb-stats-content' },
    h('p', { className: 'gb-usage-note' }, '本机 Claude Code 缓存 · 统计截至 ', h('time', { dateTime: data.asOf }, data.asOf)),
    h(MetricList, { metrics }),
    data.daily.length > 0 && h('div', { className: 'gb-stats-activity' },
      h('div', { role: 'group', 'aria-label': 'Daily activity period', className: 'gb-usage-periods' },
        [[7, 'Last 7d'], [30, 'Last 30d'], [0, 'All time']].map(([count, label]) => h('button', {
          type: 'button', key: count, 'aria-pressed': count === days, onClick: () => setDays(count),
        }, label))),
      daily.length ? h(StatsTable, { title: 'Daily activity', rows: daily, rowKey: 'date', rowLabel: 'Date', columns: activity })
        : h('p', { className: 'gb-usage-note' }, '所选时段没有记录。')),
    h(StatsTable, { title: 'Model tokens · all time', rows: data.models, rowKey: 'name', rowLabel: 'Model', columns: tokens }),
  )
}

export function ClaudeStats({ loadStats }) {
  const loader = useRef(loadStats)
  loader.current = loadStats
  const [data, setData] = useState(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setData(null)
    Promise.resolve().then(() => loader.current()).then(result => {
      if (active) setData(result ?? { available: false, reason: 'unreadable' })
    }, () => { if (active) setData({ available: false, reason: 'unreadable' }) })
    return () => { active = false }
  }, [attempt])
  if (!data) return h('p', { className: 'gb-usage-note', role: 'status' }, '正在读取本机活动统计…')
  if (!data.available) return h('div', { className: 'gb-stats-error', role: 'status' },
    h('p', { className: 'gb-usage-note' }, errors[data.reason] ?? errors.unreadable),
    h('button', { type: 'button', onClick: () => setAttempt(n => n + 1) }, '重新读取'))
  return h(StatsContents, { data })
}
