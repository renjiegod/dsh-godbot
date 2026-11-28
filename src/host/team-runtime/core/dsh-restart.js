import { accessSync, constants, realpathSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { cleanVersion, profileCli } from './update.js'

const LAUNCH_ENV = new Set(['HOME', 'PATH', 'LANG', 'LANGUAGE', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'TERM'])
const RECHECK_MS = 1000
const REPLY_GRACE_MS = 500

function restartPlan(ctx) {
  if (typeof process.execve !== 'function' || process.versions.electron || process.env.GODBOT_APP === '1') return null
  if (process.execArgv.length > 0 || process.env.NODE_OPTIONS || process.channel) return null
  if (!ctx.get?.('webApp') || typeof ctx.get?.('appExit') !== 'function' || ctx.get?.('profileContext')?.packageManager) return null
  const port = ctx.get('webServer')?.port
  if (!Number.isInteger(port) || port < 1) return null
  const args = process.argv.slice(2)
  // Replaying profile initialization could overwrite a custom profile.
  if (args.some(arg => arg === '--' || /^--from-default-profile(?:=|$)/u.test(arg))) return null
  const profile = profileCli(ctx)
  if (profile === null) return null
  try {
    if (realpathSync(process.argv[1]) !== realpathSync(profile.cli)) return null
    accessSync(profile.cli, constants.R_OK)
    accessSync(process.execPath, constants.X_OK)
    if (process.cwd() !== ctx.get('profileContext').cwd) return null
  } catch { return null }

  const env = { DSH_HOME: profile.home }
  for (const key of Object.keys(process.env)) {
    if (LAUNCH_ENV.has(key) || /^LC_[A-Z_]+$/u.test(key)) env[key] = process.env[key]
  }
  // Keep the same origin even when the first launch picked an ephemeral port.
  return { args: [process.execPath, profile.cli, ...args, '--port', String(port), '--no-open'], env }
}

function pendingActivation(update) {
  if (update?.phase !== 'installed') return false
  const current = cleanVersion(update.current)
  const installed = cleanVersion(update.installed)
  return current !== null && installed !== null && current !== installed
}

const needsRestart = (update, dsh) => update.phase !== 'installing' && dsh?.phase !== 'installing'
  && (pendingActivation(update) || pendingActivation(dsh))

function activeWork(rt) {
  const registry = rt.ctx.get('agents')
  const running = new Map()
  for (const [sessionId, entry] of rt.live) {
    if (entry.turn !== undefined) running.set(sessionId, entry.turn)
  }
  // DSH can also be running a session outside the Godbot team.
  for (const agent of registry?.list() ?? []) {
    if (agent.status !== 'running' || running.get(agent.id) > 0) continue
    const boundary = registry.turnBoundaryOf(agent.session)
    running.set(agent.id, boundary.openTurnStartSeq === null ? undefined : boundary.lastTurn)
  }
  const botName = sessionId => rt.botOf(rt.selfOf(sessionId))?.name
  return [
    ...[...running].map(([sessionId, turn]) => ({
      kind: 'turn', sessionId, bot: botName(sessionId), ...(Number.isSafeInteger(turn) && turn > 0 ? { turn } : {}),
    })),
    ...(rt.restartNativeWork?.() ?? []).map(item => ({ ...item, bot: botName(item.sessionId) })),
  ]
}

export function dshRestart(rt) {
  let job = null
  let timer
  let error

  const log = (entry, text, fields = {}) => rt.noteFailure({
    source: 'update', level: 'info', text, cause: 'update-restart',
    restartId: entry.id, restartSource: 'web', mode: entry.mode, boot: entry.boot, ...entry.target, ...fields,
  })
  const view = (includeWork = true) => ({
    boot: rt.noticeCursor().boot,
    work: includeWork || job !== null ? activeWork(rt) : [],
    ...(job === null ? {} : { phase: job.phase, id: job.id }),
    ...(error === undefined ? {} : { error }),
  })
  function checkLater(entry, delay) {
    clearTimeout(timer)
    timer = setTimeout(() => void advance(entry), delay)
    timer.unref?.()
  }

  async function advance(entry) {
    if (job !== entry) return
    try {
      if (rt.readOnly() !== undefined) throw new Error('This host no longer owns the Godbot workspace.')
      if (!needsRestart(rt.updateView(), rt.dshUpdateView?.())) throw new Error('No installed update is ready for a restart.')
      const work = activeWork(rt)
      if (work.length && entry.mode === 'when-idle') {
        entry.phase = 'waiting'
        checkLater(entry, RECHECK_MS)
        return
      }
      entry.phase = 'restarting'
      if (work.length) {
        const sessions = new Set(work.map(item => rt.ctx.get('agents')?.get(item.sessionId)?.session).filter(Boolean))
        await Promise.all([...sessions].map(session => rt.ctx.sessions.flush(session)))
        await rt.save()
        await rt.flushRestartNotes()
      }
      if (job !== entry) return
      if (rt.readOnly() !== undefined) throw new Error('This host no longer owns the Godbot workspace.')
      const affected = activeWork(rt)
      if (affected.length && entry.mode === 'when-idle') {
        entry.phase = 'waiting'
        checkLater(entry, RECHECK_MS)
        return
      }
      // Record the final set of affected turns in the same event-loop turn as
      // SIGTERM, after the session and its CLI binding have been flushed.
      rt.executionHistory.recordUpdateRestart(entry, affected)
      log(entry, 'Godbot is restarting DSH to apply an update', { outcome: 'restarting', affected: affected.length })
      entry.committed = true
      const relaunch = code => {
        if (code !== 0) return
        try { process.execve(process.execPath, entry.plan.args, entry.plan.env) }
        catch (failure) {
          process.exitCode = 1
          writeSync(2, `godbot: could not restart DSH: ${failure.message}\n`)
        }
      }
      process.once('exit', relaunch)
      try { process.kill(process.pid, 'SIGTERM') }
      catch (failure) {
        process.off('exit', relaunch)
        throw failure
      }
    } catch (failure) {
      if (job !== entry) return
      job = null
      error = failure?.message ?? String(failure)
      log(entry, `Godbot could not restart DSH: ${error}`, { level: 'warn', outcome: 'failed' })
    }
  }

  rt.ctx.effect(() => () => {
    clearTimeout(timer)
    job = null
  }, 'godbot: scheduled update restart')
  return {
    available: (update, dsh) => needsRestart(update, dsh) && restartPlan(rt.ctx) !== null,
    scheduled: () => job !== null,
    view,
    schedule(mode = 'when-idle') {
      if (!['when-idle', 'now'].includes(mode)) throw new Error('Choose when DSH should restart.')
      if (job?.committed || job && (job.mode === mode || mode === 'when-idle')) return view()
      const update = rt.updateView()
      const dsh = rt.dshUpdateView?.()
      if (!needsRestart(update, dsh)) throw new Error('No installed update is ready for a restart.')
      const plan = restartPlan(rt.ctx)
      if (plan === null) throw new Error('Restart DSH from the terminal to apply the update.')
      const work = activeWork(rt)
      const phase = mode === 'when-idle' && work.length ? 'waiting' : 'restarting'
      error = undefined
      job = { id: randomUUID(), boot: rt.noticeCursor().boot, mode, plan, phase, target: {
        ...(pendingActivation(update) ? { godbotVersion: update.installed } : {}),
        ...(pendingActivation(dsh) ? { dshVersion: dsh.installed } : {}),
      } }
      log(job, 'Godbot received a request to restart DSH', { outcome: phase, affected: work.length })
      // Allow the browser to receive the receipt before disposing the connection.
      checkLater(job, REPLY_GRACE_MS)
      return { boot: job.boot, id: job.id, phase, work }
    },
    cancel() {
      if (job?.committed) throw new Error('DSH is already restarting.')
      if (job !== null) {
        clearTimeout(timer)
        log(job, 'Godbot cancelled a scheduled restart', { outcome: 'cancelled' })
        job = null
      }
      error = undefined
      return view()
    },
  }
}
