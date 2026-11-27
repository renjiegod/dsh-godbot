import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BOT_GOAL_ROLE, HISTORY_TIMEOUT_MS, SOURCE_KIND, isBotGoalSource } from './constants.js'
import { ownConversations } from './threads.js'
import { turnOf } from './resume.js'
import { output } from './tools.js'
import { turnOutcome } from '../shared/turn-outcome.js'

const FINISHED = new Set(['completed', 'stopped'])
const CONTEXT_SOURCES = new Set(['runtime-context', 'skill-catalog', 'time-context', 'godbot-time-context', 'ds-bot-time-context'])
const competing = message => !isBotGoalSource(message.source) && !CONTEXT_SOURCES.has(message.source?.kind)
const error = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })

export function parseBotGoal(input) {
  const text = String(input ?? '').trim()
  if (!text) return { action: 'show' }
  const command = /^(edit)\s+([\s\S]+)$/iu.exec(text)
  if (command) return { action: 'edit', objective: command[2] }
  const action = text.toLowerCase()
  if (['pause', 'resume', 'stop'].includes(action)) return { action }
  if (action === 'edit') throw error('Use /goal edit <objective>.', 'bot/invalid')
  return { action: 'start', objective: text }
}

function textField(value, label, max, required = false) {
  if (typeof value !== 'string' || (required && value.trim() === '') || value.trim().length > max) {
    throw error(`${label} must contain ${required ? '1' : '0'} to ${max} characters.`, 'bot/invalid')
  }
  return value.trim()
}

// A goal runs until the agent reports it complete or blocked, or the user pauses or
// stops it. It has no turn or time budget; older clients may still send `maxTurns`
// and `maxMinutes`, which are ignored.
function spec(body, prior = {}) {
  const { objective, acceptance } = body
  return {
    objective: textField(objective ?? prior.objective, 'Objective', 4000, true),
    acceptance: textField(acceptance ?? prior.acceptance ?? '', 'Done when', 2000),
  }
}

// Goals saved before the limits were removed keep these fields until they are rewritten.
const withoutLimits = ({ maxTurns, maxMinutes, usedMs, ...goal }) => goal

const sameCheckpoint = (a, b) => a?.status === b.status && a.summary === b.summary && a.next === b.next && a.evidence === b.evidence

function promptOf(goal, attempt) {
  return [
    '[Godbot goal turn]',
    `Objective: ${goal.objective}`,
    `Done when: ${goal.acceptance || goal.objective}`,
    goal.checkpoint ? `Last checkpoint: ${goal.checkpoint.summary}` : '',
    goal.checkpoint?.evidence ? `Prior evidence: ${goal.checkpoint.evidence}` : '',
    goal.checkpoint?.next ? `Next step: ${goal.checkpoint.next}` : '',
    `Goal turn ${goal.turns + 1}. Work on a concrete step and inspect existing results before repeating actions.`,
    `Before finishing this turn, use report_bot_goal with attempt_id "${attempt.id}". Report progress with a concrete next step, blocked with the input you need, or complete with evidence that the finish condition was met. Report only the work you verified. Ask for approval through the normal tools when required.`,
  ].filter(Boolean).join('\n')
}

export function install(rt) {
  const { ctx, state } = rt
  let commits = Promise.resolve()
  let disposed = false
  let pumping = false
  const dispatching = new Set()
  const admitted = new Map()
  const cancelling = new Set()
  const waitingReasons = new Map()

  const byAnchor = anchor => rt.own(state.botGoals, anchor)
  const conversations = botId => ownConversations(rt.botOf(botId))
  const targetOf = (botId, sessionId) => conversations(botId).find(row => row.parts.includes(sessionId))
  const headOf = goal => targetOf(goal.botId, goal.anchor)
  const ongoing = sessionId => Object.values(state.botGoals).find(goal => goal.attempt?.sessionId === sessionId)
  const forSession = sessionId => {
    const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
    const row = botId && targetOf(botId, sessionId)
    const goal = row && byAnchor(row.parts[0])
    return goal?.botId === botId ? goal : undefined
  }
  const running = (sessionId, attemptId) => {
    const claim = admitted.get(sessionId)
    return claim?.turn !== undefined && claim.turn === rt.live.get(sessionId)?.turn
      && (attemptId === undefined || claim.id === attemptId)
  }
  const owns = () => !disposed && rt.ownsStateForGoals()
  const open = row => row !== undefined && row.endedAt === undefined && !ctx.workspaceRegistry?.archivedSessionIds?.includes(row.sessionId)

  function change(anchor, update, control = false) {
    const run = commits.then(async () => {
      const prior = byAnchor(anchor)
      const next = update(prior)
      if (next === undefined || next === prior) return prior
      if (!owns()) throw error(rt.readOnly() ?? 'The host cannot save and run Bot goals.', 'bot/read-only')
      next.revision = (prior?.revision ?? 0) + Number(control)
      state.botGoals[anchor] = next
      try {
        await rt.save({ required: true })
      } catch (failure) {
        if (byAnchor(anchor) === next) {
          if (prior === undefined) delete state.botGoals[anchor]
          else state.botGoals[anchor] = prior
        }
        throw failure
      }
      return next
    })
    commits = run.catch(() => {})
    return run
  }

  function view(goal, row = headOf(goal)) {
    const { id, botId, anchor, objective, acceptance, status, turns, checkpoint, reason, revision, attempt, history } = goal
    const part = attempt?.sessionId ?? row?.sessionId
    const waiting = status === 'active' && (rt.waitsForApproval?.(part) || rt.own(state.questions, part))
    const activity = waiting ? 'waiting' : attempt?.startedAt !== undefined ? 'running' : status === 'active' ? 'queued' : null
    return { id, botId, conversationId: anchor, sessionId: row?.sessionId, objective, acceptance, status, activity, turns, checkpoint, reason: reason ?? (activity === 'queued' ? waitingReasons.get(goal.id) : undefined), revision, history }
  }

  function read(botId, sessionId) {
    const row = targetOf(botId, sessionId)
    const goal = row && byAnchor(row.parts[0])
    return { available: open(row), goal: goal?.botId === botId ? view(goal, row) : null }
  }

  async function control(botId, sessionId, body) {
    await rt.load()
    const row = targetOf(botId, sessionId)
    if (!open(row) || row.sessionId !== sessionId) throw error('Open the current part of this Bot conversation to control its goal.')
    const anchor = row.parts[0]
    const action = body.action
    const requestId = typeof body.requestId === 'string' && body.requestId.length <= 160 ? body.requestId : undefined
    const next = await change(anchor, prior => {
      if (requestId && prior?.receipts?.includes(requestId)) return prior
      if (body.revision !== undefined && body.revision !== (prior?.revision ?? null)) throw error('This goal changed. Refresh it and try again.', 'bot/stale')
      const receipts = [...(prior?.receipts ?? []), ...(requestId ? [requestId] : [])].slice(-24)
      if (action === 'start') {
        if (prior && (!FINISHED.has(prior.status) || prior.attempt)) throw error('This conversation already has an unfinished goal.')
        const history = prior ? [...(prior.history ?? []), { id: prior.id, objective: prior.objective, status: prior.status, checkpoint: prior.checkpoint }].slice(-5) : []
        return { id: randomUUID(), botId, anchor, ...spec(body), receipts, status: 'active', turns: 0, stalled: 0, plan: 1, history }
      }
      if (!prior || (body.goalId !== undefined && body.goalId !== prior.id)) throw error('This conversation has no matching goal.', 'bot/stale')
      if (FINISHED.has(prior.status)) throw error('This goal has ended. Start a new goal to continue.')
      const row = { ...withoutLimits(prior), receipts }
      switch (action) {
        case 'edit': {
          const updated = spec(body, prior)
          const changed = updated.objective !== prior.objective || updated.acceptance !== prior.acceptance
          return { ...row, ...updated, ...(changed ? { plan: prior.plan + 1, checkpoint: undefined, stalled: 0 } : {}) }
        }
        case 'pause': return { ...row, status: 'paused', reason: undefined }
        case 'stop': return { ...row, status: 'stopped', reason: undefined }
        case 'resume':
          if (prior.attempt) throw error('Wait for the previous goal turn to settle before resuming.')
          return { ...row, status: 'active', reason: undefined, stalled: 0 }
        default: throw error('Unknown goal action.', 'bot/invalid')
      }
    }, true)
    if (action === 'stop' && next?.attempt) await cancel(next.attempt)
    if (next?.status !== 'active') waitingReasons.delete(next?.id)
    return view(byAnchor(anchor), targetOf(botId, anchor))
  }

  async function command(botId, sessionId, input, requestId) {
    await rt.load()
    const parsed = parseBotGoal(input)
    if (parsed.action === 'show') return read(botId, sessionId).goal
    return control(botId, sessionId, { ...parsed, requestId })
  }

  async function pauseForStop(sessionId) {
    const goal = forSession(sessionId)
    if (goal?.status === 'active') {
      await change(goal.anchor, prior => prior?.id === goal.id && prior.status === 'active'
        ? { ...prior, status: 'paused', reason: undefined } : prior, true)
    }
  }

  // Cancellation is fenced to the admitted attempt; other messages can start while
  // a user request is waiting to save, and must never be cancelled by that request.
  async function cancel(attempt) {
    const agent = ctx.agents?.get(attempt.sessionId)
    if (!agent) return
    for (const message of agent.inbox.nextTurn) {
      if (isBotGoalSource(message.source) && message.source.exchangeId === attempt.id) agent.inbox.remove(message.id)
    }
    if (running(attempt.sessionId, attempt.id)) {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await rt.stopSubagents?.(attempt.sessionId)
    }
  }

  function eligible(goal, row, sessionId) {
    return owns() && goal?.status === 'active' && open(row)
      && row.sessionId === sessionId && rt.chatOwners.get(sessionId) === goal.botId
      && !state.switching[sessionId] && !rt.nativeTerminals?.()[sessionId]
  }

  async function drop(goal, attempt, blocker) {
    return change(goal.anchor, prior => prior?.attempt?.id === attempt.id
      ? { ...prior, attempt: undefined, ...(blocker && prior.status === 'active' ? { status: 'blocked', reason: blocker } : {}) } : prior)
  }

  async function finish(goal, attempt, reason) {
    const result = turnOutcome(reason)
    return change(goal.anchor, prior => {
      if (prior?.attempt?.id !== attempt.id) return prior
      const pending = prior.attempt
      const report = pending.plan === prior.plan && result?.status === 'completed' ? pending.report : undefined
      const next = { ...withoutLimits(prior), attempt: undefined }
      if (prior.status === 'stopped') return next
      if (report !== undefined) next.checkpoint = report
      if (report?.status === 'complete') return { ...next, status: 'completed', reason: undefined }
      if (prior.status !== 'active') return next
      if (result?.status === 'stopped') return { ...next, status: 'paused' }
      if (result?.status !== 'completed') {
        const detail = reason?.error?.code === 'BOT_GOAL_NATIVE_ACTIVE'
          ? 'Pause or finish the Codex thread’s native goal first.'
          : reason?.error?.code === 'BOT_GOAL_REMOTE_UNSUPPORTED' ? 'This remote agent cannot confirm goal progress or cancellation.'
            : 'Review the last goal turn before continuing. Its outcome may be incomplete.'
        return { ...next, status: 'blocked', reason: detail }
      }
      if (pending.plan !== prior.plan) return next
      if (report?.status === 'blocked') return { ...next, status: 'blocked', reason: report.summary }
      if (report === undefined && rt.own(state.questions, pending.sessionId)) return next
      if (report === undefined) return { ...next, status: 'blocked', reason: 'The agent ended the turn without a goal report. Review the result before resuming.' }
      const stalled = sameCheckpoint(prior.checkpoint, report) ? prior.stalled + 1 : 0
      return stalled >= 2 ? { ...next, stalled, status: 'blocked', reason: 'Consecutive goal turns reported the same progress.' } : { ...next, stalled }
    })
  }

  async function reconcile(goal, agent, attempt) {
    if (dispatching.has(attempt.id) || admitted.get(attempt.sessionId)?.id === attempt.id) return
    if (attempt.startedAt === undefined) {
      if (agent?.status === 'running' || agent?.inbox.nextTurn.some(message => message.source?.exchangeId === attempt.id)) return
      await drop(goal, attempt)
      return
    }
    if (agent === undefined) {
      await finish(goal, attempt)
      return
    }
    await ctx.sessions.flush(agent.session)
    const events = []
    for await (const event of rt.eventsBackwards(attempt.sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) events.push(event)
    const turn = turnOf(events.reverse(), attempt.id)
    if (turn?.reason === undefined && agent.status === 'running') {
      if (turn !== undefined) admitted.set(attempt.sessionId, { id: attempt.id, turn: turn.turn })
      return
    }
    await finish(goal, attempt, turn?.reason)
  }

  async function drive(goal) {
    const attempt = goal.attempt
    if (attempt !== undefined) {
      await reconcile(goal, await rt.resolveAgent(attempt.sessionId).catch(() => undefined), attempt)
      const current = byAnchor(goal.anchor)
      const pending = current?.attempt
      if (pending?.id !== attempt.id || cancelling.has(attempt.id) || current.status !== 'stopped') return
      cancelling.add(attempt.id)
      try { await cancel(pending) } finally { cancelling.delete(attempt.id) }
      return
    }
    if (goal.status !== 'active') return
    const row = headOf(goal)
    const sessionId = row?.sessionId
    if (!open(row)) {
      await change(goal.anchor, prior => prior === goal ? { ...goal, status: 'paused', reason: 'This conversation is archived or the Bot was removed.' } : prior)
      return
    }
    if (!eligible(goal, row, sessionId)) return waitingReasons.set(goal.id, 'Waiting for this conversation to become available.')
    if (rt.unreadOf?.(sessionId)?.length) return waitingReasons.set(goal.id, 'Waiting for earlier queued messages.')
    if (rt.localAgentBackground?.(sessionId) || rt.hasSubagents?.(sessionId)) return waitingReasons.set(goal.id, 'Waiting for background work.')
    if (rt.waitsForApproval?.(sessionId) || rt.own(state.questions, sessionId)) return waitingReasons.set(goal.id, 'Waiting for your input.')
    waitingReasons.delete(goal.id)
    const route = rt.botOf(goal.botId)?.appliedModel ?? rt.botOf(goal.botId)?.model
    if (route?.startsWith('ag-ui-')) {
      await change(goal.anchor, prior => prior === goal ? { ...goal, status: 'blocked', reason: 'This remote agent cannot confirm goal progress or cancellation.' } : prior)
      return
    }
    await rt.ensureCapabilities(sessionId)
    const agent = await rt.resolveAgent(sessionId)
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length) {
      waitingReasons.set(goal.id, 'Waiting for the current turn and queued messages.')
      return
    }
    const pending = { id: randomUUID(), sessionId, plan: goal.plan }
    dispatching.add(pending.id)
    try {
      const saved = await change(goal.anchor, prior => prior === goal ? { ...goal, attempt: pending } : prior)
      if (saved?.attempt?.id !== pending.id) return
      if (!eligible(byAnchor(goal.anchor), headOf(goal), sessionId) || agent.status !== 'idle' || agent.inbox.nextTurn.length) {
        await drop(goal, pending)
        return
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: promptOf(saved, pending) }],
        source: { kind: SOURCE_KIND, form: 'relay', role: BOT_GOAL_ROLE, exchangeId: pending.id, goalId: goal.id },
      }))
    } finally {
      dispatching.delete(pending.id)
    }
  }

  function warn(failure) { rt.warn('godbot: Bot goal work failed: %s', failure?.message ?? String(failure)) }

  async function tick() {
    if (pumping || disposed) return
    pumping = true
    try {
      await rt.load()
      if (!owns()) return
      await Promise.all(Object.values(state.botGoals).map(goal => drive(goal).catch(warn)))
    } finally { pumping = false }
  }

  // Run after the context-switch hook has prepared the decision and recheck the
  // reservation at the last boundary before committing it as an actual turn.
  ctx.on('agent/pre-step', async (payload, next) => {
    const submitted = payload.messages.find(message => isBotGoalSource(message.source))
    if (!submitted) return next()
    const { agent } = payload
    const goal = ongoing(agent.id)
    const attempt = goal?.attempt
    const matches = attempt?.id === submitted.source.exchangeId && goal.id === submitted.source.goalId
    const valid = () => {
      const current = goal && byAnchor(goal.anchor)
      return matches && current?.attempt?.id === attempt.id && current.plan === attempt.plan
        && !payload.signal.aborted && eligible(current, headOf(current), agent.id)
    }
    const reject = async messages => {
      // Preserve real inputs the host claimed in the same step as the goal prompt.
      for (const message of messages.filter(item => !isBotGoalSource(item.source)).toReversed()) {
        if (![...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(queued => queued.id === message.id)) agent.inbox.prepend(competing(message) ? 'next-turn' : 'next-step', message)
      }
      if (matches && attempt.startedAt === undefined) await drop(goal, attempt)
      return { kind: 'reject' }
    }
    if (!valid() || payload.messages.some(competing)) return reject(payload.messages)
    const decision = await next()
    if (decision.kind !== 'enter') {
      await drop(goal, attempt, state.switching[agent.id] ? undefined : 'The goal turn was rejected before it could start.')
      return decision
    }
    if (!valid() || decision.messages.some(competing)) return reject(decision.messages)
    const entered = await change(goal.anchor, prior => prior?.attempt?.id === attempt.id && valid()
      ? { ...prior, turns: prior.turns + 1, attempt: { ...attempt, startedAt: Date.now() } } : prior)
    if (entered?.attempt?.startedAt === undefined || !valid()) {
      if (entered?.attempt?.id === attempt.id) await drop(goal, attempt)
      return { kind: 'reject' }
    }
    return { ...decision, startsRequestSeries: true }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' && event.type !== 'turn/end') return
    const id = session?.id
    const goal = ongoing(id)
    const attempt = goal?.attempt
    if (!attempt) return
    if (event.type === 'user/message' && isBotGoalSource(event.data?.source) && event.data.source.exchangeId === attempt.id) {
      admitted.set(id, { id: attempt.id, turn: rt.live.get(id)?.turn })
    }
    if (event.type !== 'turn/end') return
    const entry = admitted.get(id)
    if (entry?.id !== attempt.id || entry.turn !== event.data?.turn) return
    void ctx.sessions.flush(session).then(() => finish(goal, attempt, event.data.reason)).catch(warn).finally(() => {
      if (admitted.get(id) === entry) admitted.delete(id)
    })
  })

  rt.teamTools.push(defineTool({
    name: 'report_bot_goal',
    description: 'Report a checkpoint for the current Godbot goal turn. The goal prompt supplies the attempt id.',
    parameters: {
      attempt_id: { type: 'string', description: 'Exact attempt id in the goal prompt' },
      status: { type: 'string', enum: ['progress', 'blocked', 'complete'], description: 'Turn result' },
      summary: { type: 'string', description: 'What was done, or what blocks further work' },
      next: { type: 'string', description: 'Concrete next step, required for progress' },
      evidence: { type: 'string', description: 'Verified evidence, required for completion' },
    },
    output,
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      const goal = ongoing(sessionId)
      if (sessionId === undefined || goal?.attempt?.id !== args.attempt_id || !running(sessionId, args.attempt_id)) {
        throw error('This tool requires the current goal attempt in this conversation.')
      }
      const status = args.status
      if (!['progress', 'blocked', 'complete'].includes(status)) throw error('Unknown goal report status.', 'bot/invalid')
      const report = { status, summary: textField(args.summary, 'Progress summary', 1800, true),
        next: textField(args.next ?? '', 'Next step', 1000, status === 'progress'),
        evidence: textField(args.evidence ?? '', 'Evidence', 2000, status === 'complete') }
      await change(goal.anchor, prior => {
        if (prior?.attempt?.id !== args.attempt_id || prior.status === 'stopped' || prior.plan !== prior.attempt.plan) {
          throw error('This goal attempt is no longer current.')
        }
        return { ...prior, attempt: { ...prior.attempt, report } }
      })
      return 'Goal report saved. Finish this turn so Godbot can settle the attempt.'
    },
  }))

  Object.assign(rt, {
    botGoalRead: read, botGoalControl: control, botGoalCommand: command, pauseBotGoalForStop: pauseForStop,
    activeBotGoal: sessionId => forSession(sessionId)?.status === 'active',
    runningBotGoal: sessionId => running(sessionId),
    botGoalsView: () => Object.fromEntries(Object.values(state.botGoals).flatMap(goal => {
      const row = headOf(goal)
      if (!row) return []
      const current = view(goal, row)
      return row.parts.map(sessionId => [sessionId, current])
    })),
  })

  ctx.effect(() => {
    const timer = setInterval(() => void tick().catch(warn), 850)
    timer.unref?.()
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, 'godbot: Bot goals')
}
