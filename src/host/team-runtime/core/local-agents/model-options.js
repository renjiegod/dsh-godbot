// The options a local agent's model offers beyond the model and its thinking level:
// Codex service tiers, Claude Code fast mode, and the session config options an ACP
// agent lists. Each engine reads them from its CLI and describes them the same way,
// so the host validates a Bot's picks, and every window draws them, without knowing
// which CLI they came from:
//
//   { id, type: 'select', name, description?, values: [{ id, name, description?, native? }], defaultValue? }
//   { id, type: 'toggle', name, description?, defaultValue? }
//
// `id` is Godbot's: `speed` for the speed of the answer (one control for every CLI
// that has one), `acp:<config id>` for an ACP option. `native` is what the CLI
// takes for a value whose id is Godbot's own. `defaultValue` is what the CLI uses
// while the Bot has no pick of its own, when the CLI says.
//
// A Bot keeps its picks by option id (`bot.modelOptions`). Only an option the model
// offers, with a value it offers, reaches the CLI: a pick that does not apply to the
// current model is kept for later but never sent, like a thinking level.

export const SPEED = 'speed'
const ACP_PREFIX = 'acp:'

// Codex names the standard tier `default`, and its fast tier `priority` (`fast` is an
// alias the app-server still takes). Godbot shows both CLIs' speeds under one control.
const CODEX_SPEED = new Map([['default', 'standard'], ['priority', 'fast'], ['fast', 'fast']])
const tierSpeed = tier => CODEX_SPEED.get(tier) ?? tier

const text = (value, max = 240) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

// The speed control of one Codex model, from its model/list entry, or undefined when
// the model has only the standard tier. `configured` is the tier the user's Codex
// config picks (`service_tier`), which applies while the Bot has none of its own.
export function codexSpeedOption(entry, configured) {
  const listed = Array.isArray(entry?.serviceTiers) && entry.serviceTiers.length > 0
    ? entry.serviceTiers.map(tier => ({ native: text(tier?.id, 64), name: text(tier?.name, 64), description: text(tier?.description) }))
    // Codex before `serviceTiers` named the extra tiers only.
    : (Array.isArray(entry?.additionalSpeedTiers) ? entry.additionalSpeedTiers : []).map(id => ({ native: text(id, 64) }))
  const values = [{ id: 'standard', name: 'Standard', native: 'default' }]
  for (const tier of listed) {
    const id = tierSpeed(tier.native)
    if (!id || values.some(value => value.id === id)) continue
    values.push({
      id,
      name: tier.name || (id === 'fast' ? 'Fast' : id === 'ultrafast' ? 'Ultrafast' : id),
      ...(tier.description ? { description: tier.description } : {}),
      native: tier.native,
    })
  }
  if (values.length < 2) return undefined
  const wanted = [configured, entry?.defaultServiceTier].map(tier => (typeof tier === 'string' && tier ? tierSpeed(tier) : undefined))
  const defaultValue = wanted.find(id => id !== undefined && values.some(value => value.id === id)) ?? 'standard'
  return { id: SPEED, type: 'select', name: 'Speed', values, defaultValue }
}

// Claude Code's fast mode, for a model that says it supports it. A Claude Code that
// runs for a host serves it only once the session's flag settings ask for it, so the
// CLI's own default is standard speed.
export function claudeSpeedOption(model) {
  if (model?.supportsFastMode !== true) return undefined
  return {
    id: SPEED, type: 'select', name: 'Speed',
    values: [
      { id: 'standard', name: 'Standard', native: false },
      { id: 'fast', name: 'Fast', description: 'Faster output; draws from usage credits at a higher price.', native: true },
    ],
    defaultValue: 'standard',
  }
}

// The categories Godbot already drives through its own controls: the model menu, the
// thinking level, and the permission preset (which picks the agent's mode).
const OWN_CATEGORIES = new Set(['model', 'mode', 'thought_level', 'collaboration_mode'])
const MAX_OPTIONS = 12
const MAX_VALUES = 48

const flatChoices = options => (Array.isArray(options) ? options : [])
  .flatMap(entry => (Array.isArray(entry?.options) ? entry.options : [entry]))

// The session config options of an ACP agent that Godbot has no control of its own
// for, as options of its models.
export function acpOptions(configOptions) {
  const options = []
  for (const option of Array.isArray(configOptions) ? configOptions : []) {
    const configId = text(option?.id, 128)
    if (!configId || OWN_CATEGORIES.has(option?.category) || OWN_CATEGORIES.has(configId)) continue
    const id = ACP_PREFIX + configId
    if (options.some(entry => entry.id === id)) continue
    const base = {
      id,
      name: text(option.name, 80) || configId,
      ...(text(option.description) ? { description: text(option.description) } : {}),
      native: configId,
    }
    if (option.type === 'boolean') {
      options.push({ ...base, type: 'toggle', ...(typeof option.currentValue === 'boolean' ? { defaultValue: option.currentValue } : {}) })
    } else {
      const values = []
      for (const choice of flatChoices(option.options)) {
        const value = typeof choice?.value === 'string' ? choice.value : typeof choice?.id === 'string' ? choice.id : undefined
        if (value === undefined || value === '' || values.some(entry => entry.id === value)) continue
        values.push({ id: value, name: text(choice.name, 80) || value, ...(text(choice.description) ? { description: text(choice.description) } : {}) })
        if (values.length === MAX_VALUES) break
      }
      if (values.length < 2) continue
      options.push({ ...base, type: 'select', values, ...(values.some(entry => entry.id === option.currentValue) ? { defaultValue: option.currentValue } : {}) })
    }
    if (options.length === MAX_OPTIONS) break
  }
  return options
}

export const acpConfigId = id => (typeof id === 'string' && id.startsWith(ACP_PREFIX) ? id.slice(ACP_PREFIX.length) : undefined)

// The options as a window shows them: without what only the CLI reads.
export function publicOptions(options) {
  if (!Array.isArray(options) || options.length === 0) return undefined
  return options.map(({ native: _native, values, ...option }) => ({
    ...option,
    ...(values ? { values: values.map(({ native: _value, ...value }) => value) } : {}),
  }))
}

const BOOLEAN_WORDS = new Map([['true', true], ['on', true], ['yes', true], ['false', false], ['off', false], ['no', false]])
const normalize = value => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')

// One pick for one option, as stored: a value id of the option, or a boolean for a
// toggle. Names match too, so a Bot can say "fast" or "Ultrafast". Throws when the
// option has no such value.
export function resolveOptionValue(option, wanted) {
  if (option.type === 'toggle') {
    if (typeof wanted === 'boolean') return wanted
    const value = BOOLEAN_WORDS.get(String(wanted ?? '').trim().toLowerCase())
    if (value !== undefined) return value
    throw new Error(`${option.name} is on or off`)
  }
  const key = normalize(wanted)
  const found = option.values.filter(value => normalize(value.id) === key || normalize(value.name) === key)
  if (found.length === 1) return found[0].id
  throw new Error(`${option.name} ${String(wanted)} is not available. Available: ${option.values.map(value => value.name).join(', ')}`)
}

// A Bot's picks after a patch: `null` or '' clears a pick, anything else must be a
// value the model offers now. Picks for options the model does not offer stay as they
// were (a model switch keeps them for a model that has them again).
export function patchModelOptions(current, patch, offered) {
  const next = { ...(current ?? {}) }
  for (const [id, wanted] of Object.entries(patch ?? {})) {
    if (wanted === null || wanted === '' || wanted === undefined) {
      delete next[id]
      continue
    }
    const option = (offered ?? []).find(entry => entry.id === id)
    if (option === undefined) throw new Error(id === SPEED ? 'This model has no speed options' : `This model has no option ${id}`)
    next[id] = resolveOptionValue(option, wanted)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

// What reaches the CLI for one turn: every option the model offers, with the native
// value of the Bot's pick, or null where the Bot has none (the CLI's own setting then
// applies). A pick the model does not offer is left out.
export function nativeOptions(offered, picks) {
  if (!Array.isArray(offered) || offered.length === 0) return undefined
  const out = {}
  for (const option of offered) {
    const pick = picks?.[option.id]
    if (option.type === 'toggle') out[option.id] = typeof pick === 'boolean' ? pick : null
    else {
      const value = option.values.find(entry => entry.id === pick)
      out[option.id] = value === undefined ? null : (value.native ?? value.id)
    }
  }
  return out
}

// The picks that apply to a model, by option id: what a window shows as the Bot's.
export function appliedPicks(offered, picks) {
  const out = {}
  for (const option of offered ?? []) {
    const pick = picks?.[option.id]
    if (option.type === 'toggle' ? typeof pick === 'boolean' : option.values.some(value => value.id === pick)) out[option.id] = pick
  }
  return out
}
