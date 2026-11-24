import { accessSync, constants, realpathSync, writeSync } from 'node:fs'
import { cleanVersion, profileCli } from './update.js'

const LAUNCH_ENV = new Set(['HOME', 'PATH', 'LANG', 'LANGUAGE', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'TERM'])

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

export function dshRestart(rt) {
  let receipt = null
  return {
    available: (update, dsh) => needsRestart(update, dsh) && restartPlan(rt.ctx) !== null,
    scheduled: () => receipt !== null,
    schedule() {
      if (receipt !== null) return receipt
      if (!needsRestart(rt.updateView(), rt.dshUpdateView?.())) throw new Error('No installed update is ready for a restart.')
      const plan = restartPlan(rt.ctx)
      if (plan === null) throw new Error('Restart DSH from the terminal to apply the update.')
      receipt = { boot: rt.noticeCursor().boot }
      // Give the browser time to receive the receipt, then use DSH's SIGTERM
      // handler to close the app and persist its sessions. Replacing the process
      // at exit preserves the terminal, logs and any supervisor watching the PID.
      setTimeout(() => {
        process.once('exit', code => {
          if (code !== 0) return
          try { process.execve(process.execPath, plan.args, plan.env) }
          catch (error) {
            process.exitCode = 1
            writeSync(2, `godbot: could not restart DSH: ${error.message}\n`)
          }
        })
        process.kill(process.pid, 'SIGTERM')
      }, 500)
      return receipt
    },
  }
}
