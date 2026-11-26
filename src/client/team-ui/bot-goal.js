import { createElement as h, useState } from 'react'
import { t } from './i18n.js'

export const BOT_GOAL_CSS = `
.bt-bot-goal { margin: 4px auto; width: min(100%, 760px); color: var(--bt-ink); }
.bt-bot-goal button { font: inherit; cursor: pointer; }
.bt-bot-goal-toggle { display: flex; align-items: center; gap: 8px; max-width: 100%;
  padding: 5px 10px; border: 1px solid var(--bt-line); color: inherit; background: var(--bt-card); border-radius: 8px; }
.bt-bot-goal-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bt-muted); }
.bt-bot-goal-body { display: grid; gap: 9px; margin-top: 4px; padding: 12px;
  max-height: min(46vh, 380px); overflow: auto; border: 1px solid var(--bt-line); border-radius: 10px; background: var(--bt-card); }
.bt-bot-goal-body p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.bt-bot-goal-body label { display: grid; gap: 4px; }
.bt-bot-goal-body textarea, .bt-bot-goal-body input { box-sizing: border-box; width: 100%; padding: 6px;
  border: 1px solid var(--bt-line); border-radius: 6px; color: inherit; background: var(--bt-hover); font: inherit; }
.bt-bot-goal-limits, .bt-bot-goal-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bt-bot-goal-actions button { padding: 4px 10px; border: 1px solid var(--bt-line); border-radius: 6px; background: var(--bt-hover); color: inherit; }
.bt-bot-goal-actions button:disabled { opacity: .5; cursor: default; }
.bt-bot-goal-error { color: var(--bt-danger, #e45b5b); }
`

const ended = goal => !goal || goal.status === 'completed' || goal.status === 'stopped'

function badge(goal) {
  if (!goal) return ''
  if (goal.status === 'completed') return t('Completed')
  if (goal.status === 'stopped') return goal.activity ? t('Stopping') : t('Stopped')
  if (goal.status === 'paused') return goal.activity ? t('Pausing') : t('Paused')
  if (goal.status === 'blocked') return t('Needs review')
  if (goal.activity === 'waiting') return t('Waiting for input')
  return goal.activity === 'running' ? t('Running') : t('Queued')
}

function GoalControls({ botId, sessionId, goal, canWrite, actions }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [local, setLocal] = useState(goal)
  const shown = goal && local?.id === goal.id && local.revision > goal.revision ? local : goal ?? local
  const canStart = ended(shown) && !shown?.activity
  const editing = draft !== null
  const buttons = (...items) => h('div', { className: 'bt-bot-goal-actions' }, ...items)
  const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: pending || disabled }, t(label))
  const edit = (fresh) => setDraft(fresh
    ? { objective: '', acceptance: '', maxTurns: 8, maxMinutes: 30, revision: shown?.revision ?? null }
    : { objective: shown.objective, acceptance: shown.acceptance, maxTurns: shown.maxTurns, maxMinutes: shown.maxMinutes, revision: shown.revision })
  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }))
  async function send(action) {
    if (pending || !canWrite) return
    setPending(true)
    setError(null)
    try {
      const result = await actions.controlBotGoal({
        action, botId, sessionId, goalId: shown?.id, revision: shown?.revision ?? null,
        requestId: globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random(),
        ...(['start', 'edit'].includes(action) ? draft : {}),
      })
      setLocal(result)
      if (action === 'edit' || action === 'start') setDraft(null)
    } catch (failure) {
      setError(failure.message)
    } finally { setPending(false) }
  }
  return h('section', { className: 'bt-bot-goal', 'data-godbot-bot-goal': '' },
    h('button', {
      type: 'button', className: 'bt-bot-goal-toggle', 'aria-label': t('Goal'), 'aria-expanded': open,
      onClick: () => { setOpen(!open); if (!open && !shown && canWrite) edit(true) },
    }, h('strong', null, t('Goal')), shown ? h('span', null, badge(shown)) : null,
    shown ? h('span', { className: 'bt-bot-goal-summary', title: shown.objective }, shown.objective) : null),
    open ? h('div', { className: 'bt-bot-goal-body' },
      shown && !editing ? h('div', null,
        h('p', null, shown.objective),
        shown.acceptance ? h('p', null, t('Done when'), ' · ', shown.acceptance) : null,
        h('p', null, badge(shown), ' · ', t('{used} of {max} turns', { used: shown.turns, max: shown.maxTurns })),
        shown.reason ? h('p', null, shown.reason) : null,
        shown.checkpoint ? h('p', null, shown.checkpoint.summary) : null,
        shown.checkpoint?.evidence ? h('p', null, shown.checkpoint.evidence) : null,
        shown.checkpoint?.next ? h('p', null, t('Next step'), ' · ', shown.checkpoint.next) : null) : null,
      canWrite && editing ? h('form', { onSubmit: event => { event.preventDefault(); void send(canStart ? 'start' : 'edit') } },
        h('label', null, t('Objective'), h('textarea', { required: true, rows: 2, maxLength: 4000, value: draft.objective, onChange: event => update('objective', event.target.value) })),
        h('label', null, t('Done when'), h('textarea', { rows: 2, maxLength: 2000, value: draft.acceptance, onChange: event => update('acceptance', event.target.value) })),
        h('div', { className: 'bt-bot-goal-limits' },
          h('label', null, t('Goal turns'), h('input', { required: true, type: 'number', min: 1, max: 64, value: draft.maxTurns, onChange: event => update('maxTurns', Number(event.target.value)) })),
          h('label', null, t('Active minutes'), h('input', { required: true, type: 'number', min: 1, max: 240, value: draft.maxMinutes, onChange: event => update('maxMinutes', Number(event.target.value)) }))),
        buttons(h('button', { type: 'submit', disabled: pending }, t(canStart ? 'Start goal' : 'Save')), button('Cancel', () => setDraft(null)))) : null,
      canWrite && !editing ? (canStart ? buttons(button('Start goal', () => edit(true))) : !ended(shown)
        ? buttons(
          shown.status === 'active' ? button('Pause goal', () => void send('pause'))
            : button('Resume goal', () => void send('resume'), Boolean(shown.activity)),
          button('Edit goal', () => edit(false)),
          button('Stop goal', () => void send('stop')))
        : null) : null,
      error ? h('p', { role: 'alert', className: 'bt-bot-goal-error' }, error) : null) : null)
}

export function BotGoalDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = roster.byId?.[sessionId]
  if (!bot || roster.roomsById?.[sessionId] || roster.botGoals === undefined) return null
  const goal = roster.botGoals[sessionId]
  const current = (bot.sessionId ?? bot.id) === sessionId || bot.openParts?.some(part => part.sessionId === sessionId)
  if (!current && !goal) return null
  return h(GoalControls, { key: sessionId, sessionId, botId: bot.id, goal, actions, canWrite: current && !roster.readOnly })
}
