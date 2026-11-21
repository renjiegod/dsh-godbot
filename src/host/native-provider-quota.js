import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv, findExecutable, launchOf } from '../drivers/external/discover.js'
import { TerminalService } from './terminal-service.js'

function geminiTarget(config) {
  const env = config?.gemini?.env ?? {}
  const home = env.GEMINI_CLI_HOME ?? process.env.GEMINI_CLI_HOME ?? env.HOME ?? homedir()
  const program = findExecutable(config?.gemini?.command || 'gemini')
  // The CLI keeps the name of the active Google account in a separate public
  // identity index. Binding to it prevents reusing a snapshot after a switch.
  let email = null
  try {
    const active = JSON.parse(readFileSync(join(home, '.gemini', 'google_accounts.json'), 'utf8')).active
    if (typeof active === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(active) && active.length <= 254) email = active
  } catch { /* API-key, Vertex, and older CLI profiles may have no Google identity. */ }
  const binding = createHash('sha256').update(JSON.stringify([home, program, email, env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT])).digest('hex')
  return { binding, program, email }
}

// The CLI prints a local clock time with a rounded-up countdown. Use both
// fields, including the countdown's date, to preserve midnight rollovers.
function resetInstant(text, now) {
  const match = /^(\d{1,2}):(\d\d)\s*([AP]M)\s*\(\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?\)$/iu.exec(text)
  if (!match || (!match[4] && !match[5]) || +match[1] < 1 || +match[1] > 12 || +match[2] > 59) return null
  const estimated = now + (Number(match[4] || 0) * 60 + Number(match[5] || 0)) * 60000
  const reset = new Date(estimated)
  reset.setHours(+match[1] % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0), +match[2], 0, 0)
  if (reset.getTime() - estimated > 12 * 3600000) reset.setDate(reset.getDate() - 1)
  if (estimated - reset.getTime() > 12 * 3600000) reset.setDate(reset.getDate() + 1)
  return Math.abs(reset.getTime() - estimated) <= 120000 ? reset.toISOString() : null
}

export function geminiModelQuota(lines, now = Date.now()) {
  if (!lines.some(s => s.includes('Select Model'))) return []
  const heading = lines.findIndex(s => /^(?:[│┃]\s*)?Model usage\s*(?:[│┃])?$/iu.test(s.trim()))
  if (heading < 0) return []
  const windows = new Map()
  for (const line of lines.slice(heading + 1)) {
    const match = /^\s*[│┃]?\s*([\w][\w .+/-]{0,48}?)\s*▬+\s*(\d{1,3})%\s*(?:Resets:\s*([^│┃]+?))?\s*[│┃]?\s*$/u.exec(line)
    if (!match || +match[2] > 100) continue
    const label = match[1].trim(), usedPercent = +match[2]
    windows.set(label, { id: label, label, usedPercent, remainingPercent: 100 - usedPercent,
      resetsAt: resetInstant(match[3]?.trim() ?? '', now) })
  }
  return [...windows.values()]
}

async function readGemini(subprocess, target, config) {
  if (!target.program || !subprocess?.spawnTerminal) return {status:'unavailable', reason:'source-unavailable'}
  const cwd = await mkdtemp(join(tmpdir(), 'godbot-gemini-quota-'))
  const terminals = new TerminalService(subprocess, { replayBytes: 65536, scrollback: 0 })
  try {
    const dir = join(cwd, '.gemini')
    await mkdir(dir)
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      admin:{extensions:{enabled:false}, mcp:{enabled:false}}, hooksConfig:{enabled:false},
      general:{enableAutoUpdate:false, enableAutoUpdateNotification:false, vimMode:false},
    }), {mode:0o600})
    const launch = launchOf(target.program, ['--skip-trust', '--extensions', 'godbot-no-extensions', '--allowed-mcp-server-names', 'godbot-no-servers'])
    if (launch.options?.windowsVerbatimArguments) return {status:'unavailable', reason:'unsupported'}
    const cleaned = cleanEnv()
    const env = Object.fromEntries(Object.keys(process.env).filter(k => !Object.hasOwn(cleaned,k)).map(k => [k,undefined]))
    for (const key of Object.keys(cleaned)) if (key.toUpperCase() === 'PATH') env[key] = cleaned[key]
    Object.assign(env, config?.gemini?.env, {NO_BROWSER:'true', BROWSER:'false', TERM:'xterm-256color', LANG:'en_US.UTF-8'})
    const { terminalId } = await terminals.open({ command:launch.file, args:launch.args, cwd, env, cols:140, rows:52 })
    const screen = terminals.require(terminalId).screen
    let typed = false, sent = false, cursor = 0, dialogAt = 0
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const frame = await terminals.read(terminalId, { cursor, waitMs:400 })
      cursor = frame.cursor
      const buffer = screen.buffer.active
      const lines = Array.from({length:screen.rows}, (_,i) => buffer.getLine(buffer.baseY+i)?.translateToString(true) ?? '')
      const visible = lines.join('\n')
      if (/Enter the authorization code:|Please visit the following URL to authorize the application|How would you like to authenticate/i.test(visible))
        return {status:'signed-out', reason:'not-authenticated'}
      if (typed && visible.includes('Select Model')) {
        const windows = geminiModelQuota(lines)
        if (windows.length) return target.email ? {status:'available', email:target.email, windows}
          : {status:'unavailable', reason:'not-reported'}
        dialogAt ||= Date.now()
        if (Date.now() - dialogAt > 5000) return {status:'unavailable', reason:'not-reported', email:target.email}
      } else if (!typed && visible.includes('Type your message or') && !frame.exit) {
        // Open only the built-in chooser in an empty scratch project. Never
        // select a model, submit an inference prompt, or continue an auth flow.
        typed = true
        await terminals.write(terminalId, '/model')
      } else if (typed && !sent && visible.includes('/model') && /Manage model configuration|Open the model dialog/iu.test(visible) && !frame.exit) {
        sent = true
        await terminals.write(terminalId, '\r')
      }
      if (frame.exit) break
    }
    return {status:'unavailable',reason:'source-unavailable',email:target.email}
  } finally {
    try { await terminals.dispose() } finally { await rm(cwd,{recursive:true,force:true}) }
  }
}

export function nativeUsageAdapters(subprocess) {
  return { gemini:{ source:'gemini-cli-model', target:geminiTarget,
    read:(target,config) => readGemini(subprocess,target,config) } }
}
