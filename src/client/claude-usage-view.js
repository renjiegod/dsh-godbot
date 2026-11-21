import { createElement as h, useId, useState } from 'react'
import { usageStyle } from './claude-usage-style.js'
import { ClaudeStats, ClaudeSessionUsage } from './claude-stats-view.js'

function Quota({ label, percent, reset }) {
  return h('div', { className: 'gb-usage-quota' },
    h('div', { className: 'gb-usage-limit' },
      h('strong', null, label),
      h('span', { className: 'gb-usage-value' }, `${percent}% used`)),
    h('meter', { min: 0, max: 100, value: percent, 'aria-label': label, 'aria-valuetext': `${percent}% used`,
      style: { '--cu-used': Math.max(0, Math.min(100, percent)) + '%' } }),
    reset && h('div', { className: 'gb-usage-reset' }, reset),
  )
}

function ShareTable({ label, items, more }) {
  return h('table', { className: 'gb-usage-table', 'aria-label': label },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, label),
      h('th', { scope: 'col' }, '% of usage'))),
    h('tbody', null,
      ...items.map((item, i) => h('tr', { key: i },
        h('td', null, item.label),
        h('td', null, `${item.percent}%`))),
      more && h('tr', null, h('td', { colSpan: 2, className: 'gb-usage-more' }, more))),
  )
}

function ReportTabs({ id, title, labels, active, onSelect, className }) {
  function navigate(event, index) {
    let next
    if (event.key === 'ArrowLeft') next = (index - 1 + labels.length) % labels.length
    else if (event.key === 'ArrowRight') next = (index + 1) % labels.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = labels.length - 1
    else return
    event.preventDefault()
    event.stopPropagation()
    onSelect(next)
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus()
  }
  return h('div', { className, role: 'tablist', 'aria-label': title },
      labels.map((label, i) => h('button', {
        type: 'button', role: 'tab', key: label, id: id + '-tab-' + i,
        'aria-selected': i === active, 'aria-controls': id + '-panel-' + i,
        tabIndex: i === active ? 0 : -1, onClick: () => onSelect(i), onKeyDown: event => navigate(event, i),
      }, label)))
}

function UsagePeriods({ periods, notes }) {
  const id = useId()
  const [choice, setChoice] = useState(0)
  const active = Math.min(choice, periods.length - 1)
  const period = periods[active]
  return h('section', { className: 'gb-usage-breakdown', 'aria-labelledby': id + '-heading' },
    h('h4', { id: id + '-heading' }, "What's contributing to your usage?"),
    notes.map((note, i) => h('p', { className: 'gb-usage-note', key: i }, note)),
    h(ReportTabs, { id, title: 'Usage period', labels: periods.map(item => item.label), active, onSelect: setChoice, className: 'gb-usage-periods' }),
    periods.map((item, i) => h('div', {
      role: 'tabpanel', key: item.label, id: id + '-panel-' + i, 'aria-labelledby': id + '-tab-' + i,
      className: 'gb-usage-period', hidden: i !== active, tabIndex: 0,
    }, i === active && [
      period.totals && h('p', { className: 'gb-usage-totals', key: 'totals' }, period.totals),
      period.recommendations.length > 0 && h('ul', { className: 'gb-usage-advice', key: 'advice' },
        period.recommendations.map((suggestion, n) => h('li', { key: n },
          h('span', { className: 'gb-usage-share' }, `${suggestion.percent}%`),
          h('span', null, suggestion.label,
            suggestion.detail && h('span', { className: 'gb-usage-detail' }, ' · ', suggestion.detail))))),
      ...period.tables.map((table, n) => h(ShareTable, { key: 'table-' + n, ...table })),
    ])),
  )
}

function Usage({ usage, sessionUsage }) {
  return h('div', null,
    usage.headline && h('p', { className: 'gb-usage-note' }, usage.headline),
    usage.quota.length > 0 && h('div', { className: 'gb-usage-quotas' },
      usage.quota.map((quota, i) => h(Quota, { ...quota, key: i }))),
    usage.periods.length > 0
      ? h(UsagePeriods, { periods: usage.periods, notes: usage.notes })
      : usage.notes.map((note, i) => h('p', { className: 'gb-usage-note', key: i }, note)),
    sessionUsage && h(ClaudeSessionUsage, { session: sessionUsage }),
    h('details', { className: 'gb-usage-source' },
      h('summary', null, '查看 CLI 原文'),
      h('pre', null, usage.raw)),
  )
}

export function ClaudeUsageView({ usage, loadStats, initialTab = 'usage', sessionUsage, rawOutput, elementRef }) {
  const id = useId()
  const [tab, setTab] = useState(initialTab)
  const tabs = [...(usage || rawOutput ? ['Usage'] : []), ...(loadStats ? ['Stats'] : [])]
  const active = Math.max(0, tabs.findIndex(name => name.toLowerCase() === tab))
  if (!tabs.length) return null
  return h('section', { ref: elementRef, className: 'gb-claude-usage', 'aria-label': 'Claude Code ' + tabs[active],
    'data-native-command': initialTab === 'stats' ? 'claude-stats' : 'claude-usage' },
    h('style', null, usageStyle),
    tabs.length > 1
      ? h(ReportTabs, { id, title: 'Claude Code reports', labels: tabs, active, onSelect: next => setTab(tabs[next].toLowerCase()), className: 'gb-usage-nav' })
      : h('header', { className: 'gb-usage-heading' }, h('h3', null, tabs[0])),
    tabs.map((name, i) => h('div', {
      hidden: i !== active, key: name,
      ...(tabs.length > 1 ? { role: 'tabpanel', id: id + '-panel-' + i, 'aria-labelledby': id + '-tab-' + i } : {}),
    }, active === i && (name === 'Stats' ? h(ClaudeStats, { loadStats })
      : usage ? h(Usage, { usage, sessionUsage }) : h('pre', { className: 'gb-usage-verbatim' }, rawOutput)))),
  )
}
