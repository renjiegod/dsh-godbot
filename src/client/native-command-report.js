import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseClaudeUsage } from './claude-usage.js'
import { ClaudeUsageView } from './claude-usage-view.js'
import { claudeReportName, isNativeReportCommand } from './report-command.js'

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

// /context supplies Markdown tables. Let the native Markdown renderer preserve
// its full set of sections, including project files and tools from the active CLI.
const reportStyle = `
.gb-cli-report{box-sizing:border-box;width:100%;min-width:0;padding:14px 16px;border:.5px solid var(--bt-line-2,#85859055);border-radius:12px;background:var(--bt-tag-bg,transparent);color:inherit;overflow-wrap:anywhere}
.gb-cli-report header{font:600 13px/1.5 ui-monospace,monospace;margin-bottom:8px}
.gb-cli-report pre{white-space:pre-wrap;font:13px/1.55 ui-monospace,monospace;overflow-wrap:anywhere;max-width:100%;margin:0}
.gb-cli-report [data-markdown-variant]{max-width:100%;overflow:auto}
.gb-cli-report table{font-variant-numeric:tabular-nums}
.gb-cli-report details{font-size:12px;margin-top:12px}
.gb-cli-report summary{cursor:pointer}
`

// Native snapshots and DSH event windows may lack an older command's receipt.
// Only ask for its exact registered identity, once per mounted message.
function useReportSession(current, loadSession, key, enabled, element) {
  const loader = useRef(loadSession)
  loader.current = loadSession
  const [saved, setSaved] = useState(null)
  const missing = enabled && current === undefined && !!loadSession && !!key
  useEffect(() => {
    if (!missing) return
    let active = true
    const read = () => loader.current().then(value => {
      if (active) setSaved({ key, value })
    }).catch(() => { /* The CLI's original report remains readable. */ })
    // Opening long histories should never scan every old transcript at once.
    let observer
    if (element.current && globalThis.IntersectionObserver) {
      observer = new IntersectionObserver(entries => {
        if (!active || !entries.some(entry => entry.isIntersecting)) return
        observer.disconnect()
        void read()
      })
      observer.observe(element.current)
    } else void read()
    return () => { active = false; observer?.disconnect() }
  }, [key, missing, element])
  return current === undefined && saved && saved.key === key ? saved.value : current
}

export function NativeCommandReport({ agent, command, text, loadStats, sessionUsage: current, loadSession, receiptKey }) {
  const element = useRef(null)
  const name = claudeReportName(command)
  const usage = useMemo(() => ['usage', 'stats', 'cost'].includes(name) && parseClaudeUsage(text), [name, text])
  const sessionUsage = useReportSession(current, loadSession, receiptKey, !!usage, element)
  if (!isNativeReportCommand(agent, command)) return null
  if (usage || (name === 'stats' && loadStats)) return h(ClaudeUsageView, {
    usage, loadStats, sessionUsage, rawOutput: text, elementRef: element, initialTab: name === 'stats' ? 'stats' : 'usage',
  })
  const markdown = name === 'context' && /^#{1,3}\s/mu.test(text)
  return h('section', { className: 'gb-cli-report', 'data-native-command': 'claude-' + name,
    'aria-label': 'Claude Code /' + name },
    h('style', null, reportStyle),
    h('header', null, 'Claude Code /' + name),
    markdown ? h(MarkdownText, { text, labels, variant: 'compact' }) : h('pre', null, text),
    markdown && h('details', null, h('summary', null, '查看原始输出'), h('pre', null, text)),
  )
}
