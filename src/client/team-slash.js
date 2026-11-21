// The team editor already owns a trigger menu, command chips, draft restoration
// and submission. Contribute to that source registry so a slash command uses the
// same IME, keyboard, mouse, and retry paths as the rest of the composer.
import { pendingRequests } from './model.js'

const agents = new Map([
  ['local-claude-code', 'Claude Code'],
  ['local-codex-cli', 'Codex'],
  ['local-antigravity', 'Antigravity'],
])
const settings = new Set(['model', 'effort', 'permissions'])
const cacheMs = 30_000
const bindings = new WeakMap()

export function teamSlashSource(roster, actions, client) {
  const catalogs = new Map()
  let storage
  try { storage = globalThis.sessionStorage } catch { /* In-memory retries still work. */ }
  const pending = pendingRequests(storage)

  function target(session) {
    const state = roster.getSnapshot()
    const bot = state.byId?.[session.sessionId]
    if (state.readOnly || !bot || state.roomsById?.[session.sessionId]) return
    // A stored Bot id is also its first part. Never direct an old part's
    // command to a different, current CLI session.
    if ((bot.sessionId ?? bot.id) !== session.sessionId) return
    const model = bot.model ?? bot.appliedModel ?? state.defaultModel
    const route = typeof model === 'string' ? model.split('/')[0] : undefined
    const agent = agents.get(route)
    if (agent) return {
      botId: bot.id, agent, route,
      key: JSON.stringify([bot.id, session.sessionId, model, bot.workDir, state.workspace]),
    }
  }

  function catalog(here) {
    let entry = catalogs.get(here.botId)
    if (entry?.key === here.key && entry.expires > Date.now()) return entry
    entry = { key: here.key, expires: Infinity }
    catalogs.set(here.botId, entry)
    entry.ready = Promise.resolve().then(() => client.slashCommands({ botId: here.botId })).then(commands => {
      entry.commands = commands
      entry.expires = Date.now() + cacheMs
      return commands
    }, error => {
      if (catalogs.get(here.botId) === entry) catalogs.delete(here.botId)
      throw error
    })
    return entry
  }

  function checkCurrent(session, here) {
    if (target(session)?.key !== here.key) throw new Error('Bot 的运行设置或对话已切换，请重新选择命令。')
  }

  function claim(session, here, command) {
    const name = command.name
    return {
      name, token: '/' + name + ' ', hint: command.inputHint || command.description,
      async submit(args, _ctx, attachments) {
        checkCurrent(session, here)
        if (attachments?.length) throw new Error('请将附件作为单独的消息发送，原生命令仅接收文本。')
        if (command.kind === 'terminal') {
          if (settings.has(name) && !args.trim()) {
            actions.openSettings('bots', here.botId)
            return { kind: 'success' }
          }
          if (name === 'status' && !args.trim()) {
            actions.showDetails(session.sessionId)
            return { kind: 'success' }
          }
          return { kind: 'error', text: settings.has(name)
            ? `请使用 /${name} 打开这个 Bot 的设置并选择值。`
            : `/${name} 需要在 ${here.agent} 终端中使用。` }
        }
        const request = {
          botId: here.botId, sessionId: session.sessionId, expectedRoute: here.route,
          name, args,
        }
        const receipt = await pending.begin(request)
        await client.runSlash({ ...request, requestId: receipt.id })
        pending.complete(receipt)
        return { kind: 'success' }
      },
    }
  }

  const commandFor = (commands, token) => commands?.find(command => '/' + command.name === token)
  async function resolve(session, token, signal) {
    const here = target(session)
    if (!here || !token?.startsWith('/') || token.length < 2) return
    const commands = await catalog(here).ready
    signal?.throwIfAborted()
    checkCurrent(session, here)
    const command = commandFor(commands, token)
    if (command) return claim(session, here, command)
  }

  return {
    trigger: '/', name: 'godbot-native-agent', order: -100, showGroupTitle: false,
    accepts: session => !!target(session),
    async candidates(session, { position, query, signal }) {
      const here = target(session)
      if (!here || position !== 'leading') return []
      const commands = await catalog(here).ready
      signal?.throwIfAborted()
      if (target(session)?.key !== here.key) return []
      const needle = query.toLowerCase()
      const rows = commands.filter(command => command.name.toLowerCase().includes(needle))
      if (needle) {
        const rank = ({ name }) => name.toLowerCase() === needle ? 0 : name.toLowerCase().startsWith(needle) ? 1 : 2
        rows.sort((left, right) => rank(left) - rank(right))
      }
      return rows.map(command => {
        const handling = command.kind !== 'terminal' ? '' : settings.has(command.name)
          ? 'Bot 设置' : command.name === 'status' ? '会话状态' : 'CLI 终端'
        return {
          name: '/' + command.name, section: here.agent, value: here.key,
          description: [handling, command.description].filter(Boolean).join(' · '),
          hint: command.inputHint,
        }
      })
    },
    onPick({ action, session, candidate }) {
      if (action === 'drill') return
      const here = target(session)
      if (!here || candidate.value !== here.key) return
      const entry = catalogs.get(here.botId)
      const command = entry?.key === here.key && commandFor(entry.commands, candidate.name)
      if (command) return { claim: claim(session, here, command) }
    },
    matchSpace(session, token) {
      const here = target(session)
      if (!here) return
      const entry = catalogs.get(here.botId)
      const command = entry?.key === here.key && commandFor(entry.commands, token)
      if (command) return { claim: claim(session, here, command) }
    },
    async matchEnter(session, line, signal, envelope) {
      const matched = await resolve(session, line.trim().split(/\s/u, 1)[0], signal)
      if (!matched) return
      if (envelope?.attachments > 0) throw new Error('请将附件作为单独的消息发送，原生命令仅接收文本。')
      return { claim: matched }
    },
    matchClaim: resolve,
  }
}

/** DSH orders menu rows by source.order, but the pinned shell adjudicates a
 * pasted line and restores a saved chip in registration order. Give this Bot's
 * own names first refusal on those two public entry points as well. */
export function bindTeamSlashSource(controller, source, sessionId) {
  if (!controller) return
  const binding = bindings.get(controller)
  if (binding?.source === source) {
    binding.count++
    return binding.release
  }
  const session = { sessionId }
  const previousEnter = controller.adjudicate
  const previousRestore = controller.resolveClaim
  const previousKey = controller.arbitrate
  const enter = async (line, signal, envelope) => {
    const native = await source.matchEnter(session, line, signal, envelope)
    return native ?? previousEnter.call(controller, line, signal, envelope)
  }
  const restore = async (token, signal) => {
    const native = await source.matchClaim(session, token, signal)
    return native ?? previousRestore.call(controller, token, signal)
  }
  controller.adjudicate = enter
  controller.resolveClaim = restore
  // DSH keeps the first source that resolves highlighted (often /side). A
  // slower native catalog owns the initial selection, unless the user already
  // moved it with the mouse or keyboard.
  let prior = controller.menu?.getSnapshot()
  let userSelected = false
  const offMenu = controller.menu?.subscribe(() => {
    const next = controller.menu.getSnapshot()
    if (!next.open || next.generation !== prior?.generation) userSelected = false
    else if (next.groups === prior.groups && next.highlight !== prior.highlight) userSelected = true
    const group = next.groups.find(item => item.source === source.name)
    const wasPending = prior?.groups.some(item => item.source === source.name && item.status === 'pending')
    prior = next
    if (!userSelected && wasPending && group?.status === 'ready' && group.items.length && next.highlight?.source !== source.name) {
      controller.hover(source.name, 0)
    }
  })
  const key = (action, composing) => {
    if (!composing && prior?.open && prior.hit?.position === 'leading' && (action === 'enter' || action === 'tab')) {
      const native = prior.groups.find(item => item.source === source.name)
      if (!userSelected && native?.status === 'pending' && source.accepts(session)) return 'consumed'
      if (action === 'enter' && prior.highlight?.source === source.name &&
          native?.items[prior.highlight.index]?.name === '/' + prior.hit.query) return 'pass'
    }
    return previousKey.call(controller, action, composing)
  }
  if (previousKey) controller.arbitrate = key
  const current = {
    source, count: 1,
    release() {
      if (--current.count > 0) return
      offMenu?.()
      if (controller.adjudicate === enter) controller.adjudicate = previousEnter
      if (controller.resolveClaim === restore) controller.resolveClaim = previousRestore
      if (controller.arbitrate === key) controller.arbitrate = previousKey
      bindings.delete(controller)
    },
  }
  bindings.set(controller, current)
  return current.release
}
