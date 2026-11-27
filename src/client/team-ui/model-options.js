// The options a local agent's model offers besides its thinking level: one Speed
// control for every CLI that has faster tiers (Codex service tiers, Claude Code fast
// mode), then the agent's own on/off and choice options (an ACP agent's config). The
// host describes them the same way for every CLI (core/local-agents/model-options.js),
// so nothing here knows which CLI it draws for. A Bot keeps its picks by option id;
// the CLI's own setting applies to an option the Bot has not picked.
import { createElement as h, useRef, useState } from 'react'
import { BoltIcon } from './icons.js'
import { t } from './i18n.js'
import { SPRING_POP } from './motion.js'

// Thinking levels by their usual ids, in the interface language. Any other level
// keeps the name its CLI gives it.
const EFFORT_NAMES = { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
export const effortName = effort => (effort === undefined ? undefined
  : Object.hasOwn(EFFORT_NAMES, effort.id) ? t(EFFORT_NAMES[effort.id]) : (effort.name ?? effort.id))

const SPEED_NAMES = { standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast' }
const valueName = value => (Object.hasOwn(SPEED_NAMES, value.id) ? t(SPEED_NAMES[value.id]) : value.name ?? value.id)
const optionName = option => (option.id === 'speed' ? t('Speed') : option.name ?? option.id)

export const speedOption = options => (options ?? []).find(option => option.id === 'speed' && option.type === 'select')

// How many bolts a speed shows: none for the first (standard) tier, one for the next,
// two for any faster.
const boltsOf = (option, value) => Math.min(2, Math.max(0, option.values.findIndex(entry => entry.id === value?.id)))

// The speed a Bot runs at: its own pick when the model offers it, else the CLI's
// default. Undefined for a model with one speed.
export function speedOf(options, picks) {
  const option = speedOption(options)
  if (option === undefined || option.values.length < 2) return undefined
  const picked = option.values.find(value => value.id === picks?.speed)
  const value = picked ?? option.values.find(value => value.id === option.defaultValue) ?? option.values[0]
  return { option, value, picked: picked !== undefined, bolts: boltsOf(option, value), name: valueName(value) }
}

// The bolts beside a model's name in its trigger and the conversation header.
export function SpeedMark({ speed }) {
  if (speed === undefined || speed.bolts === 0) return null
  return h('span', { className: 'bt-speed-mark', 'data-bolts': speed.bolts, title: t('Speed: {speed}', { speed: speed.name }) }, h(BoltIcon, { count: speed.bolts, size: 11 }))
}

const ResetIcon = () => h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M2.8 6.5A5.5 5.5 0 1 1 4 11.8' }),
  h('path', { d: 'M2.5 3.2v3.4h3.4' }))

const sameValue = (a, b) => (a ?? null) === (b ?? null)

// One pick at a time per option shows at once, and holds until the save answers: the
// host's answer arrives with the team read that follows it, so the roster has the
// pick by then. A failed save drops back to what the roster says.
function usePicks(picks, onPick) {
  const [pending, setPending] = useState({})
  const serial = useRef({})
  const shown = id => (Object.hasOwn(pending, id) ? pending[id] : picks?.[id])
  const pick = (id, value) => {
    const ticket = (serial.current[id] ?? 0) + 1
    serial.current[id] = ticket
    setPending(previous => ({ ...previous, [id]: value }))
    const settle = () => {
      if (serial.current[id] !== ticket) return
      setPending(({ [id]: _settled, ...rest }) => rest)
    }
    let saving
    try { saving = onPick(id, value) } catch { settle(); return }
    void Promise.resolve(saving).then(settle, settle)
  }
  return [shown, pick]
}

function OptionHead({ option, picked, valueLabel, onReset }) {
  return h('div', { className: 'bt-mo-head' },
    h('span', { className: 'bt-mo-label' }, optionName(option)),
    h('span', { className: 'bt-mo-meta' },
      picked ? null : h('span', { className: 'bt-mo-tag' }, t('Default')),
      valueLabel === undefined ? null : h('span', { className: 'bt-mo-val' }, valueLabel),
      picked
        ? h('button', { type: 'button', className: 'bt-mo-reset', 'aria-label': t('Default'), title: t('Default'), onClick: onReset }, h(ResetIcon))
        : null))
}

// A choice of a few values: one segment each, the bolts on faster speeds. More values
// than fit take a list instead.
function ChoiceOption({ option, value, onPick }) {
  const picked = option.values.find(entry => entry.id === value)
  const active = picked ?? option.values.find(entry => entry.id === option.defaultValue)
  const isSpeed = option.id === 'speed'
  const hint = active?.description ? t(active.description) : (!isSpeed && option.description ? option.description : undefined)
  const segments = option.values.length <= 4
  return h('div', { className: 'bt-mo', 'data-option': option.id },
    h(OptionHead, { option, picked: picked !== undefined, valueLabel: segments ? undefined : (active ? valueName(active) : undefined), onReset: () => onPick(option.id, null) }),
    segments
      ? h('div', { className: 'bt-mo-seg', role: 'radiogroup', 'aria-label': optionName(option) },
          option.values.map((entry) => {
            const bolts = isSpeed ? boltsOf(option, entry) : 0
            const checked = active?.id === entry.id
            return h('button', {
              key: entry.id, type: 'button', role: 'radio', 'aria-checked': checked,
              'data-default': entry.id === option.defaultValue || undefined,
              title: entry.description ? t(entry.description) : undefined,
              onClick: () => { if (!sameValue(entry.id, value)) onPick(option.id, entry.id) },
            },
            bolts > 0 ? h(BoltIcon, { count: bolts, size: 10 }) : null,
            h('span', null, valueName(entry)))
          }))
      : h('select', {
          className: 'bt-mo-select', 'aria-label': optionName(option), value: active?.id ?? '',
          onChange: event => onPick(option.id, event.target.value),
        }, option.values.map(entry => h('option', { key: entry.id, value: entry.id }, valueName(entry)))),
    hint ? h('div', { className: 'bt-mo-hint' }, hint) : null)
}

function ToggleOption({ option, value, onPick }) {
  const picked = typeof value === 'boolean'
  const on = picked ? value : option.defaultValue === true
  return h('div', { className: 'bt-mo', 'data-option': option.id },
    h('div', { className: 'bt-mo-row' },
      h('span', { className: 'bt-mo-label' }, optionName(option)),
      h('span', { className: 'bt-mo-meta' },
        picked ? h('button', { type: 'button', className: 'bt-mo-reset', 'aria-label': t('Default'), title: t('Default'), onClick: () => onPick(option.id, null) }, h(ResetIcon)) : h('span', { className: 'bt-mo-tag' }, t('Default')),
        h('button', {
          type: 'button', role: 'switch', className: 'bt-mo-switch', 'aria-checked': on, 'aria-label': optionName(option),
          onClick: () => onPick(option.id, !on),
        }, h('span', { className: 'bt-mo-knob', 'aria-hidden': true })))),
    option.description ? h('div', { className: 'bt-mo-hint' }, option.description) : null)
}

// The panel under the thinking level. `picks` are the Bot's (bot.modelOptions);
// `onPick(id, value)` saves one and hands back the save (null clears the pick).
export function ModelOptions({ options, picks, onPick }) {
  const [shown, pick] = usePicks(picks, onPick)
  const list = (options ?? []).filter(option => option.type === 'toggle' || (option.values?.length ?? 0) >= 2)
  if (list.length === 0) return null
  // Speed first: the option every CLI with tiers shares.
  const ordered = [...list.filter(option => option.id === 'speed'), ...list.filter(option => option.id !== 'speed')]
  return h('div', { className: 'bt-model-options' }, ordered.map(option => option.type === 'toggle'
    ? h(ToggleOption, { key: option.id, option, value: shown(option.id), onPick: pick })
    : h(ChoiceOption, { key: option.id, option, value: shown(option.id), onPick: pick })))
}

export const hasModelOptions = options => (options ?? []).some(option => option.type === 'toggle' || (option.values?.length ?? 0) >= 2)

export const OPTIONS_CSS = `
.bt-model-options{display:flex;flex-direction:column;gap:8px;padding:2px 6px 4px}
.bt-model-effort .bt-model-options{padding:2px 12px 4px}
.bt-mo{display:flex;flex-direction:column;gap:5px;min-width:0}
.bt-mo-head,.bt-mo-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:18px;padding:0 2px}
.bt-mo-label{font-size:11px;line-height:14px;font-weight:500;color:var(--bt-ink-3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-mo-meta{display:inline-flex;align-items:center;gap:6px;min-width:0}
.bt-mo-tag{font-size:11px;line-height:14px;color:var(--bt-ink-3)}
.bt-mo-val{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-accent);white-space:nowrap}
.bt-mo button.bt-mo-reset{flex:none;position:relative;width:28px;height:28px;min-height:0;margin:-5px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing};transition:color .12s ease}
.bt-mo button.bt-mo-reset::before{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--bt-hover);transition:background-color .12s ease}
.bt-mo button.bt-mo-reset svg{position:relative;margin:0}
.bt-mo button.bt-mo-reset:hover{color:var(--bt-ink)}
.bt-mo button.bt-mo-reset:hover::before{background:var(--bt-active)}
.bt-mo button.bt-mo-reset:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-mo-seg{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--bt-hover);box-shadow:inset 0 0 0 .5px var(--bt-line)}
.bt-mo-seg button{flex:1 1 0;min-width:0;height:26px;min-height:0;padding:0 6px;border:0;border-radius:7px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:3px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,color .12s ease,box-shadow .12s ease}
.bt-mo-seg button span{overflow:hidden;text-overflow:ellipsis}
.bt-mo-seg button:hover:not([aria-checked=true]){color:var(--bt-ink);background:var(--bt-active)}
.bt-mo-seg button[aria-checked=true]{background:var(--bt-card);color:var(--bt-ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px var(--bt-line)}
.bt-mo-seg button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-mo[data-option=speed] .bt-mo-seg button .bt-bolt{color:var(--bt-ink-3);flex:none}
.bt-mo[data-option=speed] .bt-mo-seg button[aria-checked=true] .bt-bolt{color:#d97706}
.bt-mo-hint{padding:0 2px;font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bt-mo-select{height:28px;padding:0 8px;border:0;border-radius:8px;background:var(--bt-hover);box-shadow:inset 0 0 0 .5px var(--bt-line);color:var(--bt-ink);font:inherit;font-size:12px}
.bt-mo-switch{flex:none;position:relative;width:30px;height:18px;min-height:0;padding:0;border:0;border-radius:999px;background:color-mix(in srgb,var(--bt-ink-3) 40%,transparent);cursor:pointer;transition:background-color .15s ease}
.bt-mo-switch[aria-checked=true]{background:var(--bt-accent)}
.bt-mo-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s ease}
.bt-mo-switch[aria-checked=true] .bt-mo-knob{transform:translateX(12px)}
.bt-mo-switch:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-speed-mark{display:inline-flex;align-items:center;flex:none;color:#d97706;margin-left:3px;vertical-align:-1px}
.bt-speed-mark[data-bolts="2"]{color:#ea580c}
@media (prefers-reduced-motion:reduce){.bt-mo-seg button,.bt-mo-switch,.bt-mo-knob{transition:none}.bt-mo button.bt-mo-reset{animation:none}}
`
