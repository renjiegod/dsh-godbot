// Modified for Godbot. See THIRD_PARTY_NOTICES.
import { createElement as h, useEffect, useState } from 'react'
import { triggerText } from '../automation-editor.js'
import { ChevronRightIcon, ClockIcon } from './icons.js'
import { t } from './i18n.js'

export function BotSchedules({ bot, actions }) {
  return h('section', { className: 'bt-set-section' },
    h('h3', null, t('Automation')),
    h('div', { className: 'bt-set-card' },
      h('button', { type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('automation', { scope: bot.id }) },
        h('span', { className: 'bt-set-copy' }, t('View automations for this Bot')), h(ChevronRightIcon))))
}

export function ScheduleSummary({ bot, actions }) {
  const [items, setItems] = useState([])
  useEffect(() => {
    let stopped = false
    let timer
    async function load() {
      try {
        const view = await actions.godbot.automations()
        if (!stopped) setItems(view.items)
      } catch {
        // The list reports read errors and offers a retry.
      } finally {
        if (!stopped) timer = setTimeout(load, 30_000)
      }
    }
    void load()
    return () => { stopped = true; clearTimeout(timer) }
  }, [actions.godbot])
  const plans = items.filter(item => item.target.id === bot.id && item.status !== 'finished').slice(0, 3)
  const open = () => actions.openSettings('automation', { scope: bot.id })
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t('Automation')),
    plans.length ? h('div', { className: 'bt-task-list' }, plans.map(plan => h('button', {
      key: plan.source + '/' + plan.id, type: 'button', className: 'bt-task-line', onClick: open,
    }, h(ClockIcon), h('span', { className: 'bt-task-line-title' }, plan.title),
    h('span', { className: 'bt-task-line-when' }, triggerText(plan.trigger))))) : null,
    h('button', { type: 'button', className: 'bt-more', onClick: open }, t('View automations for this Bot')))
}

export const SCHEDULE_CSS = [
  '.bt-task-list{display:grid;gap:2px}',
  '.bt-task-line{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:13px;text-align:left;cursor:pointer}',
  '.bt-task-line:hover{background:var(--bt-hover)}',
  '.bt-task-line svg{flex:none;color:var(--bt-ink-3)}',
  '.bt-task-line-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.bt-task-line-when{max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--bt-ink-3)}',
].join('\n')
