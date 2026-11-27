import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GoalIcon } from './icons.js'
import { hostText, t } from './i18n.js'
import { useLinger, useViewport, viewBottom } from './motion.js'

// A Bot conversation's goal lives in its composer: `/goal` (or "+" → Set a goal) starts
// one, and a chip beside the "+" shows how it is going. The chip opens a panel with the
// latest checkpoint and the controls. A goal has no turn or time budget: it runs until
// the Bot reports it reached or blocked, or the user pauses or ends it.

// One glyph for goals across Godbot: group goals, this chip, and its menu rows.
export const BotGoalGlyph = GoalIcon

export const BOT_GOAL_CSS = `
.bt-goal-anchor{display:none}
.bt-goal-chip{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:min(340px,42vw);height:28px;margin-left:6px;padding:0 11px 0 9px;border:0;border-radius:14px;background:color-mix(in srgb,var(--bt-ink) 5%,transparent);box-shadow:inset 0 0 0 .5px var(--bt-line);color:var(--bt-ink-2);font:inherit;font-size:12.5px;line-height:16px;cursor:pointer;box-sizing:border-box;transition:background-color .15s ease,color .15s ease;animation:bt-goal-chip-in .22s cubic-bezier(.2,.9,.3,1.2)}
.bt-goal-chip:hover,.bt-goal-chip[aria-expanded=true]{background:color-mix(in srgb,var(--bt-ink) 10%,transparent);color:var(--bt-ink)}
.bt-goal-chip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-goal-chip svg{flex:none;width:14px;height:14px;color:var(--bt-goal-tone,currentColor)}
.bt-goal-state{flex:none;max-width:calc(100% - 30px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--bt-goal-tone,var(--bt-ink))}
.bt-goal-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-goal-dot{flex:none;width:6px;height:6px;margin-right:-2px;border-radius:50%;background:var(--bt-goal-tone,var(--bt-ink-3))}
[data-goal-phase=running] .bt-goal-dot{animation:bt-goal-pulse 1.4s ease-in-out infinite}
[data-goal-phase=running]{--bt-goal-tone:var(--bt-accent)}
[data-goal-phase=queued],[data-goal-phase=pausing],[data-goal-phase=stopping]{--bt-goal-tone:var(--bt-ink-2)}
[data-goal-phase=waiting],[data-goal-phase=paused]{--bt-goal-tone:var(--bt-star)}
[data-goal-phase=blocked]{--bt-goal-tone:var(--bt-danger)}
[data-goal-phase=completed]{--bt-goal-tone:var(--bt-green)}
[data-goal-phase=stopped],[data-goal-phase=draft]{--bt-goal-tone:var(--bt-ink-3)}
@keyframes bt-goal-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes bt-goal-chip-in{from{opacity:0;scale:.92}}
.bt-goal-pop{position:fixed;z-index:60;display:flex;flex-direction:column;gap:10px;max-height:min(62vh,480px);overflow:auto;padding:12px 14px 12px;border-radius:14px;background:var(--bt-glass-bg);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:.5px solid var(--bt-glass-rim);box-shadow:var(--bt-glass-shadow),0 0 0 1px rgba(228,228,228,.04);color:var(--bt-ink);font-family:var(--bt-font);font-size:13px;line-height:19px;box-sizing:border-box;outline:none;transform-origin:bottom left;animation:bt-pop-lift .2s cubic-bezier(.2,.9,.3,1.1),bt-veil-in .14s ease-out}
.bt-goal-pop[data-leaving]{opacity:0;translate:0 4px;transition:opacity .12s ease,translate .12s ease}
.bt-goal-head{display:flex;align-items:center;gap:8px;min-height:22px}
.bt-goal-title{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px}
.bt-goal-title svg{width:14px;height:14px}
.bt-goal-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--bt-goal-tone,var(--bt-ink-2)) 12%,transparent);color:var(--bt-goal-tone,var(--bt-ink-2));font-size:12px;line-height:18px;font-weight:500}
.bt-goal-badge .bt-goal-dot{margin-right:0}
.bt-goal-turns{margin-left:auto;color:var(--bt-ink-3);font-size:12px;white-space:nowrap}
.bt-goal-objective{margin:0;font-size:14px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-goal-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 12px;margin:0;padding:10px 0 0;border-top:.5px solid var(--bt-line)}
.bt-goal-facts dt{color:var(--bt-ink-3);font-size:12px;line-height:19px}
.bt-goal-facts dd{margin:0;color:var(--bt-ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.bt-goal-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.bt-goal-actions .bt-goal-push{margin-left:auto}
.bt-goal-end{color:var(--bt-danger)}
.bt-goal-end[data-armed]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent)}
.bt-goal-error{margin:0;color:var(--bt-danger);font-size:12px;line-height:18px}
.bt-goal-form{display:flex;flex-direction:column;gap:8px;margin:0}
.bt-goal-ask{font-size:13px;font-weight:600}
.bt-goal-flabel{color:var(--bt-ink-2);font-size:12px;line-height:16px;margin-top:2px}
.bt-goal-field{min-height:0!important;resize:none!important;line-height:19px!important;font-size:13px!important}
.bt-goal-note{margin:0;color:var(--bt-ink-3);font-size:12px;line-height:17px}
[data-composer-card][data-bt-goal] [data-composer-input]:has([data-composer-command="goal"]){--dsh-composer-hint:var(--bt-goal-hint)!important}
@media (max-width:520px){.bt-goal-chip .bt-goal-text{display:none}}
`

const ENDED = new Set(['completed', 'stopped'])
export const goalEnded = goal => goal === undefined || goal === null || ENDED.has(goal.status)

export function goalPhase(goal) {
  switch (goal.status) {
    case 'completed': return 'completed'
    case 'stopped': return goal.activity ? 'stopping' : 'stopped'
    case 'paused': return goal.activity ? 'pausing' : 'paused'
    case 'blocked': return 'blocked'
    default: return goal.activity === 'waiting' ? 'waiting' : goal.activity === 'running' ? 'running' : 'queued'
  }
}

const PHASE_LABELS = {
  running: 'Working', queued: 'Queued', waiting: 'Waiting for you', pausing: 'Pausing', paused: 'Paused',
  blocked: 'Needs you', stopping: 'Stopping', stopped: 'Goal ended', completed: 'Goal reached',
}
export const goalPhaseLabel = goal => t(PHASE_LABELS[goalPhase(goal)])

// Whether this composer can start a goal now: the Bot's current conversation, writable,
// with no unfinished goal.
export function canStartBotGoal(roster, sessionId) {
  const bot = roster.byId?.[sessionId]
  if (!bot || roster.roomsById?.[sessionId] || roster.readOnly || roster.botGoals === undefined) return false
  if ((bot.sessionId ?? bot.id) !== sessionId) return false
  const goal = roster.botGoals[sessionId]
  return goalEnded(goal) && !goal?.activity
}

// A finished goal stays on the chip until it is put away; that choice belongs to this browser.
const DISMISSED = 'godbot:bot-goal-dismissed'
function readDismissed() {
  try { return new Set(JSON.parse(globalThis.localStorage?.getItem(DISMISSED) ?? '[]')) } catch { return new Set() }
}
function rememberDismissed(id) {
  try { globalThis.localStorage?.setItem(DISMISSED, JSON.stringify([...readDismissed(), id].slice(-40))) } catch { /* private mode */ }
}

const requestId = () => globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random()
const keepComposerFocus = event => event.preventDefault()
const grow = (box) => {
  if (!box) return
  box.style.height = 'auto'
  box.style.height = `${Math.min(box.scrollHeight, 200)}px`
}

// The slot entry beside the composer's "+". It always leaves a hidden anchor, which
// finds the composer card for the `/goal` hint even while no goal is shown.
export function BotGoalChip({ sessionId, useRoster, useUi, actions }) {
  const roster = useRoster(value => value)
  const composing = useUi(state => state.botGoalCompose === sessionId) === true
  const anchor = useRef(null)
  const bot = roster.byId?.[sessionId]
  const known = Boolean(bot) && !roster.roomsById?.[sessionId] && roster.botGoals !== undefined
  const goal = known ? roster.botGoals[sessionId] : undefined
  const waitReason = goal && (roster.botGoalWaits === undefined ? goal.reason : roster.botGoalWaits[goal.id])
  const current = Boolean(bot) && ((bot.sessionId ?? bot.id) === sessionId || bot.openParts?.some(part => part.sessionId === sessionId))
  const unfinished = !goalEnded(goal)
  // `/goal` in this composer: say what the Bot does with it, and how an unfinished goal is
  // controlled instead of the DSH hint about an agent goal.
  useEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]')
    if (!known || !card) return undefined
    card.dataset.btGoal = unfinished ? 'unfinished' : 'none'
    card.style.setProperty('--bt-goal-hint', JSON.stringify(unfinished
      ? t('This chat has a goal: type pause, resume or stop, or edit and the new goal')
      : t('Describe the goal. The Bot keeps working until it is done')))
    return () => {
      delete card.dataset.btGoal
      card.style.removeProperty('--bt-goal-hint')
    }
  }, [known, unfinished])
  return h(Fragment, null,
    h('span', { ref: anchor, className: 'bt-goal-anchor', 'aria-hidden': true }),
    known && (current || goal) ? h(GoalChip, {
      key: sessionId, sessionId, botId: bot.id, botName: bot.name, goal, waitReason, composing: composing && current, actions,
      canWrite: current && !roster.readOnly,
    }) : null)
}

function GoalChip({ sessionId, botId, botName, goal, waitReason, composing, canWrite, actions }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [armed, setArmed] = useState(false)
  const [local, setLocal] = useState(goal)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [shownPop, leaving] = useLinger(open, 120)
  const chip = useRef(null)
  const pop = useRef(null)
  const objectiveBox = useRef(null)
  // Opened from the keyboard: the panel takes focus so Tab walks its controls.
  const focusPanel = useRef(false)
  const tick = useViewport()
  // The control call answers before the next team state does; a newer answer wins.
  const shown = goal && local?.id === goal.id && local.revision > goal.revision ? local : goal ?? local
  const ended = goalEnded(shown)
  const fresh = draft?.fresh === true

  useEffect(() => {
    if (!composing) return
    setDraft({ objective: '', acceptance: '', fresh: true })
    setError(null)
    setArmed(false)
    setOpen(true)
  }, [composing])
  // A goal that changes under an open edit (ended elsewhere, replaced) drops the edit.
  useEffect(() => {
    if (draft && !draft.fresh && (ended || draft.id !== shown?.id)) setDraft(null)
  }, [shown?.id, ended])
  useEffect(() => { setArmed(false) }, [shown?.status])
  // Leaving the conversation with the "+" form open does not bring it back later.
  const composingNow = useRef(composing)
  composingNow.current = composing
  useEffect(() => () => { if (composingNow.current) actions.closeBotGoalCompose() }, [])

  const close = () => {
    setOpen(false)
    setDraft(null)
    setArmed(false)
    setError(null)
    if (composing) actions.closeBotGoalCompose()
  }
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (![chip.current, pop.current].some(node => node?.contains(event.target))) latest.current()
    }
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.stopPropagation()
      if (draft && !draft.fresh) { setDraft(null); setError(null) } else latest.current()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open, draft])
  useLayoutEffect(() => { if (draft) grow(objectiveBox.current) }, [draft !== null])
  useLayoutEffect(() => {
    if (!open || !focusPanel.current) return
    focusPanel.current = false
    if (!draft) pop.current?.focus({ preventScroll: true })
  }, [open])

  const place = useMemo(() => {
    if (!shownPop || !chip.current) return null
    const rect = chip.current.getBoundingClientRect()
    const width = Math.min(400, window.innerWidth - 24)
    return { left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom: viewBottom() - rect.top + 8, width }
  }, [shownPop, open, tick, draft !== null])

  if (!composing && !draft && (!shown || (ended && dismissed.has(shown.id)))) return null

  async function control(action, extra = {}) {
    if (pending || !canWrite) return undefined
    setPending(true)
    setError(null)
    try {
      const result = await actions.controlBotGoal({
        action, botId, sessionId, requestId: requestId(),
        ...(action === 'start' ? {} : { goalId: shown?.id }), revision: shown?.revision ?? null, ...extra,
      })
      setLocal(result)
      return result
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
      return undefined
    } finally { setPending(false) }
  }
  async function submit() {
    const objective = draft.objective.trim()
    if (!objective || pending) return
    const result = await control(fresh ? 'start' : 'edit', { objective, acceptance: draft.acceptance.trim() })
    if (!result) return
    setDraft(null)
    if (fresh) {
      setOpen(false)
      if (composing) actions.closeBotGoalCompose()
    }
  }
  const putAway = () => {
    rememberDismissed(shown.id)
    setDismissed(readDismissed())
    close()
  }
  const startNew = () => {
    setError(null)
    setDraft({ objective: '', acceptance: '', fresh: true })
  }
  const onChange = key => (event) => {
    const value = event.target.value
    setDraft(current => ({ ...current, [key]: value }))
    grow(event.currentTarget)
  }
  const onFieldKey = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  const phase = draft?.fresh || !shown ? 'draft' : goalPhase(shown)
  const queuedReason = phase === 'queued' && waitReason
  const label = queuedReason ? hostText(queuedReason) : phase === 'draft' ? t('New goal') : goalPhaseLabel(shown)
  const button = (text, onClick, { disabled = false, className = '' } = {}) => h('button', {
    type: 'button', className: ('bt-soft bt-soft-sm ' + className).trim(), disabled: pending || disabled, onClick,
  }, text)

  const form = () => h('form', { className: 'bt-goal-form', onSubmit: (event) => { event.preventDefault(); void submit() } },
    h('div', { className: 'bt-goal-ask' }, fresh ? t('What should {name} get done?', { name: botName }) : t('Edit goal')),
    h('textarea', {
      ref: objectiveBox, className: 'bt-input bt-input-area bt-goal-field', rows: 2, maxLength: 4000, required: true,
      'aria-label': t('Goal'), placeholder: t('Describe the goal'), value: draft.objective,
      onChange: onChange('objective'), onKeyDown: onFieldKey,
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus: true,
    }),
    h('label', { className: 'bt-goal-flabel' }, t('Finished when (optional)'),
      h('textarea', {
        className: 'bt-input bt-input-area bt-goal-field', rows: 1, maxLength: 2000, value: draft.acceptance,
        placeholder: t('How to tell it is done. Leave it empty to judge by the goal itself'),
        onChange: onChange('acceptance'), onKeyDown: onFieldKey, style: { marginTop: 4 },
      })),
    fresh ? h('p', { className: 'bt-goal-note' }, t('{name} keeps working turn after turn until the goal is reached or it needs you.', { name: botName })) : null,
    error ? h('p', { role: 'alert', className: 'bt-goal-error' }, error) : null,
    h('div', { className: 'bt-goal-actions' },
      h('span', { className: 'bt-goal-push' }),
      button(t('Cancel'), () => { if (composing || !shown) close(); else { setDraft(null); setError(null) } }),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: pending || !draft.objective.trim() }, t(fresh ? 'Start goal' : 'Save'))))

  const details = () => {
    const facts = [
      shown.acceptance ? [t('Finished when'), shown.acceptance] : null,
      shown.reason && !ended && phase !== 'queued' ? [t('Note'), hostText(shown.reason)] : null,
      shown.checkpoint?.summary ? [t('Latest progress'), shown.checkpoint.summary] : null,
      shown.checkpoint?.next && !ended ? [t('Next step'), shown.checkpoint.next] : null,
      shown.checkpoint?.evidence ? [t('Evidence'), shown.checkpoint.evidence] : null,
    ].filter(Boolean)
    const controls = !canWrite ? null : ended
      ? h('div', { className: 'bt-goal-actions' },
        button(t('New goal'), startNew, { disabled: Boolean(shown.activity) }),
        h('span', { className: 'bt-goal-push' }),
        button(t('Put away'), putAway))
      : h('div', { className: 'bt-goal-actions' },
        shown.status === 'active'
          ? button(t('Pause'), () => void control('pause'))
          : button(t('Resume'), () => void control('resume'), { disabled: Boolean(shown.activity) }),
        button(t('Edit'), () => { setError(null); setDraft({ id: shown.id, objective: shown.objective, acceptance: shown.acceptance ?? '' }) }),
        h('span', { className: 'bt-goal-push' }),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm bt-goal-end', 'data-armed': armed || undefined, disabled: pending || shown.status === 'stopped',
          onClick: () => { if (armed) void control('stop'); else setArmed(true) },
        }, armed ? t('End the goal?') : t('End goal')))
    return h(Fragment, null,
      h('div', { className: 'bt-goal-head' },
        h('span', { className: 'bt-goal-title' }, h(BotGoalGlyph, { size: 14 }), t('Goal')),
        h('span', { className: 'bt-goal-badge' }, h('span', { className: 'bt-goal-dot', 'aria-hidden': true }), label),
        shown.turns > 0 ? h('span', { className: 'bt-goal-turns' }, t('Turn {n}', { n: shown.turns })) : null),
      h('p', { className: 'bt-goal-objective' }, shown.objective),
      facts.length ? h('dl', { className: 'bt-goal-facts' }, ...facts.flatMap(([term, text], index) => [
        h('dt', { key: 't' + index }, term), h('dd', { key: 'd' + index }, text)])) : null,
      error ? h('p', { role: 'alert', className: 'bt-goal-error' }, error) : null,
      controls)
  }

  return h('span', { className: 'bt-goal-slot', 'data-godbot-bot-goal': '', 'data-goal-phase': phase },
    h('button', {
      ref: chip, type: 'button', className: 'bt-goal-chip', 'aria-haspopup': 'dialog', 'aria-expanded': open,
      'aria-label': phase === 'draft' ? t('New goal') : [t('Goal'), label, shown?.objective].filter(Boolean).join(' · '),
      title: queuedReason ? [label, shown.objective].join(' · ') : shown?.objective,
      onMouseDown: keepComposerFocus,
      onClick: (event) => {
        if (open) { close(); return }
        focusPanel.current = event.detail === 0
        setError(null)
        setOpen(true)
      },
    },
    h(BotGoalGlyph, { size: 14 }),
    phase === 'draft' ? null : h('span', { className: 'bt-goal-dot', 'aria-hidden': true }),
    h('span', { className: 'bt-goal-state' }, label),
    phase !== 'draft' && shown?.objective ? h('span', { className: 'bt-goal-text' }, shown.objective) : null),
    shownPop ? createPortal(h('div', {
      ref: pop, className: 'bt-goal-pop', role: 'dialog', 'aria-label': t('Goal'), tabIndex: -1,
      'data-goal-phase': phase, 'data-leaving': leaving || undefined, style: place ?? {},
    }, draft ? form() : shown ? details() : null), document.body) : null)
}
