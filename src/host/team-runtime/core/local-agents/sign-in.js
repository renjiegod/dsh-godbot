// Signing a local agent CLI in from Godbot's interface, without a terminal of the
// user's own. Godbot runs the CLI's own login command and hands its link, its
// one-time code and its prompts to the page; the CLI keeps the credential it gets,
// and Godbot never reads or stores it.
//
// Two ways to run that command:
// - 'pipe' (Claude Code, Codex): the CLI on plain pipes. Its printed link and
//   device code are read from its output, and a link it would open in a browser is
//   caught through BROWSER, a script that writes it to a file. A code the user
//   pastes back goes to the CLI's stdin; a pasted http://localhost callback address
//   is replayed to the CLI's own loopback listener.
// - 'terminal' (other CLIs, whose sign-in is an interactive screen): the CLI's
//   sign-in command in a pseudo-terminal the page shows.
// Either way the CLI decides when it is done, and its own sign-in check confirms.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv, findExecutable, launchOf, spawnAgent } from '../../../../drivers/external/discover.js'

const TIMEOUT_MS = 10 * 60_000
const WAIT_MAX_MS = 20_000
const OUTPUT_MAX = 64 * 1024
const PASTE_MAX = 4_096
// How long a finished sign-in stays readable by the page that started it.
const KEEP_MS = 5 * 60_000
const OPENED_POLL_MS = 150
const TERMINAL_CHECK_MS = 3_000

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]/g
export const stripAnsi = text => String(text).replace(ANSI, '').replace(/\r(?!\n)/g, '\n')

const URL_TEXT = /https:\/\/[^\s"'<>`]+/
// A device code: groups of capitals and digits joined by dashes, printed after "code".
const DEVICE_CODE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/
// What Claude Code's code page shows: the authorization code and the state, joined by '#'.
export const PASTED_CODE = /^[A-Za-z0-9_.~-]+#[A-Za-z0-9_.~-]+$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const trimUrl = url => url.replace(/[.,;:)\]}>'"]+$/u, '')

// The first https link in a CLI's output, and the device code after the word "code".
export function readLoginOutput(text) {
  const url = URL_TEXT.exec(text)?.[0]
  const at = text.search(/\bcode\b/i)
  const code = at === -1 ? undefined : DEVICE_CODE.exec(text.slice(at).replace(URL_TEXT, ' '))?.[0]
  return { url: url === undefined ? undefined : trimUrl(url), code }
}

// The loopback port a sign-in link sends the browser back to, from its redirect_uri.
export function callbackPortOf(link) {
  try {
    const redirect = new URL(new URL(link).searchParams.get('redirect_uri') ?? '')
    if (redirect.protocol !== 'http:' || !LOOPBACK.has(redirect.hostname)) return undefined
    return Number(redirect.port) || undefined
  } catch { return undefined }
}

// A CLI's last words for the page, without links or codes in them.
export function redactLine(text) {
  const lines = stripAnsi(text).split('\n').map(line => line.trim()).filter(Boolean)
  // A prompt the CLI printed without a newline ("Paste code here if prompted > ") is not its words.
  const last = (lines.at(-1) ?? '').replace(/^Paste code here if prompted\s*>\s*/iu, '')
  return last.replace(/https?:\/\/\S+/g, '<link>').replace(DEVICE_CODE, '<code>')
    .replace(/[A-Za-z0-9_.~-]{20,}#[A-Za-z0-9_.~-]+/g, '<code>').slice(0, 300)
}

// The program and arguments of a sign-in command line ("agy acp --login"), with the
// CLI's own program where it names it.
export function commandOf(line, spec, path) {
  const words = String(line ?? '').trim().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return undefined
  const [program, ...args] = words
  if (args.some(arg => /[\0\r\n]/u.test(arg))) return undefined
  const own = [spec.command, ...(spec.commands ?? [])].includes(program)
  const file = own && path !== undefined ? path : findExecutable(program)
  return file === undefined ? undefined : { file, args }
}

// The environment of a pseudo-terminal: DSH's terminal provider merges it over its
// own, so every variable the cleaned environment leaves out is unset explicitly.
function terminalEnv(extra) {
  const cleaned = cleanEnv(extra)
  const env = Object.fromEntries(Object.keys(process.env).filter(key => !Object.hasOwn(cleaned, key)).map(key => [key, undefined]))
  return { ...env, ...cleaned, TERM: 'xterm-256color' }
}

const BROWSER_SCRIPT = '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$GODBOT_LOGIN_OPENED"\n'

// `target(route)` is { spec, path } for a CLI that is installed, `probe(route)` its
// sign-in check (true, false, or null when it cannot tell), `signedIn(route)` what
// a confirmed sign-in changes, `terminals()` a TerminalService or undefined.
export function createLocalSignIn({ target, probe, signedIn, terminals, spawn = spawnAgent, envOf = cleanEnv, timeoutMs = TIMEOUT_MS, temp = tmpdir(), platform = process.platform } = {}) {
  const sessions = new Map()
  const byRoute = new Map()
  let disposed = false

  const view = (session) => ({
    loginId: session.id,
    route: session.route,
    name: session.name,
    method: session.method,
    methods: session.methods,
    kind: session.kind,
    state: session.state,
    version: session.version,
    ...(session.url === undefined ? {} : { url: session.url }),
    ...(session.autoUrl === undefined ? {} : { autoUrl: session.autoUrl }),
    ...(session.code === undefined ? {} : { code: session.code }),
    ...(session.paste === undefined ? {} : { paste: session.paste }),
    ...(session.error === undefined ? {} : { error: session.error }),
    ...(session.verified === undefined ? {} : { verified: session.verified }),
    ...(session.terminalId === undefined ? {} : { terminal: { cols: session.cols, rows: session.rows } }),
  })

  const changed = (session) => {
    session.version++
    for (const wake of session.waiters.splice(0)) wake()
  }

  const finished = session => ['done', 'failed', 'canceled'].includes(session.state)

  function end(session, state, error) {
    if (finished(session)) return
    session.state = state
    if (error !== undefined) session.error = error
    clearTimeout(session.timer)
    clearInterval(session.poll)
    session.stop?.()
    changed(session)
    if (byRoute.get(session.route) === session.id) byRoute.delete(session.route)
    setTimeout(() => sessions.delete(session.id), KEEP_MS).unref?.()
  }

  // Signed in. What the sign-in changes (the CLI's old processes closed, its Bots
  // unblocked) is done before the page hears of it, so that a turn the page then
  // runs again finds the new sign-in.
  async function succeed(session, verified) {
    if (finished(session)) return
    session.verified = verified
    try { await signedIn(session.route) } catch {}
    end(session, 'done')
  }

  // The CLI is done: its own check says whether it is signed in now.
  async function confirm(session, { exitCode, manual = false } = {}) {
    if (finished(session)) return
    session.state = 'verifying'
    changed(session)
    let result = null
    try { result = await probe(session.route) } catch { result = null }
    if (finished(session)) return
    if (result === false) {
      if (manual) { session.state = session.running ? 'waiting' : 'exited'; changed(session) }
      else end(session, 'failed', { reason: 'still-signed-out' })
      return result
    }
    if (result === null && !manual && exitCode !== 0) {
      end(session, 'failed', { reason: 'exit', ...(session.lastLine ? { detail: session.lastLine } : {}) })
      return result
    }
    await succeed(session, result === true)
    return result
  }

  async function startPipe(session, login, found) {
    const dir = await mkdtemp(join(temp, 'godbot-login-'))
    session.cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {})
    const opened = join(dir, 'opened')
    const env = { ...envOf(found.spec.env ?? {}), NO_COLOR: '1' }
    if (platform !== 'win32') {
      const browser = join(dir, 'browser')
      await writeFile(browser, BROWSER_SCRIPT, { mode: 0o700 })
      Object.assign(env, { BROWSER: browser, GODBOT_LOGIN_OPENED: opened })
    }
    let out = ''
    let child
    try {
      child = spawn(found.path, login.args, { cwd: homedir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      session.cleanup()
      end(session, 'failed', { reason: 'spawn' })
      return
    }
    session.running = true
    session.child = child
    const read = (chunk) => {
      if (out.length < OUTPUT_MAX) out += stripAnsi(chunk)
      session.lastLine = redactLine(out)
      if (finished(session)) return
      const { url, code } = readLoginOutput(out)
      let moved = false
      if (url !== undefined && session.url === undefined) { session.url = url; moved = true }
      if (login.code === true && code !== undefined && session.code === undefined) { session.code = code; moved = true }
      session.callbackPort ??= callbackPortOf(session.url ?? '')
      if (session.state === 'starting' && (session.url !== undefined || session.code !== undefined)) { session.state = 'waiting'; moved = true }
      if (moved) changed(session)
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.stdin?.on('error', () => {})
    session.poll = setInterval(() => {
      void readFile(opened, 'utf8').then((text) => {
        const link = text.split('\n').map(line => line.trim()).find(line => line.startsWith('https://'))
        if (link === undefined || session.autoUrl !== undefined || finished(session)) return
        session.autoUrl = link
        session.callbackPort = callbackPortOf(link) ?? session.callbackPort
        if (session.state === 'starting') session.state = 'waiting'
        changed(session)
      }, () => {})
    }, OPENED_POLL_MS)
    session.stop = () => {
      if (session.running) {
        child.kill('SIGTERM')
        setTimeout(() => { if (session.running) child.kill('SIGKILL') }, 2_000).unref?.()
      }
      session.cleanup()
    }
    child.on('error', () => {
      session.running = false
      end(session, 'failed', { reason: 'spawn' })
    })
    child.on('close', (exitCode) => {
      session.running = false
      clearInterval(session.poll)
      session.cleanup()
      if (finished(session)) return
      if (exitCode !== 0) {
        const outdated = /unknown option|unexpected argument|unrecognized/i.test(out)
        end(session, 'failed', { reason: outdated ? 'outdated' : 'exit', ...(session.lastLine ? { detail: session.lastLine } : {}) })
        return
      }
      void confirm(session, { exitCode })
    })
  }

  async function startTerminal(session, found, { cols, rows }) {
    const service = terminals?.()
    const command = commandOf(found.spec.signIn, found.spec, found.path)
    if (service === undefined || command === undefined) {
      end(session, 'failed', { reason: service === undefined ? 'no-terminal' : 'unsupported' })
      return
    }
    const launch = launchOf(command.file, command.args)
    if (launch.options?.windowsVerbatimArguments) { end(session, 'failed', { reason: 'unsupported' }); return }
    session.cols = cols
    session.rows = rows
    session.service = service
    try {
      const opened = await service.open({ command: launch.file, args: launch.args, cwd: homedir(), env: terminalEnv(found.spec.env ?? {}), cols, rows })
      session.terminalId = opened.terminalId
    } catch {
      end(session, 'failed', { reason: 'spawn' })
      return
    }
    session.running = true
    session.state = 'waiting'
    changed(session)
    session.stop = () => { session.running = false; void service.close(session.terminalId).catch(() => {}) }
    // A CLI whose sign-in a command can check is followed while its screen runs;
    // the user may sign in and leave it open.
    const checks = found.spec.signedIn !== undefined
    session.poll = setInterval(() => {
      if (finished(session)) return
      const info = service.info(session.terminalId)
      if (info?.exit && session.running) {
        session.running = false
        void probe(session.route).catch(() => null).then((result) => {
          if (finished(session)) return
          if (result === true) void succeed(session, true)
          else { session.state = 'exited'; changed(session) }
        })
        return
      }
      if (!checks || session.checking) return
      session.checking = true
      void probe(session.route).catch(() => null).then((result) => {
        session.checking = false
        if (result !== true || finished(session)) return
        void succeed(session, true)
      })
    }, TERMINAL_CHECK_MS)
  }

  function sessionOf(id) {
    const session = sessions.get(String(id ?? ''))
    if (session === undefined) throw new Error('This sign-in has ended. Start it again.')
    return session
  }

  return {
    // The ways a CLI can sign in here: [] when it has none.
    methodsOf(spec) {
      if (spec?.login?.length > 0) return spec.login.map(login => login.id)
      return spec?.signIn ? ['terminal'] : []
    },

    async start({ route, method, cols = 100, rows = 30 } = {}) {
      if (disposed) throw new Error('Godbot is shutting down.')
      const found = target(String(route ?? ''))
      if (found === undefined) throw new Error('This agent CLI is not installed on this computer.')
      const methods = this.methodsOf(found.spec)
      if (methods.length === 0) throw new Error('This agent has no sign-in Godbot can run. Sign in the way its documentation describes.')
      const chosen = method === undefined ? methods[0] : String(method)
      if (!methods.includes(chosen)) throw new Error('Unknown sign-in method')
      const previous = sessions.get(byRoute.get(found.route) ?? '')
      if (previous !== undefined) end(previous, 'canceled')
      const login = found.spec.login?.find(entry => entry.id === chosen)
      const session = {
        id: randomUUID(), route: found.route, name: found.spec.name, method: chosen, methods,
        kind: login === undefined ? 'terminal' : 'pipe', state: 'starting', version: 0, waiters: [],
        ...(login?.paste === undefined ? {} : { paste: login.paste }),
      }
      sessions.set(session.id, session)
      byRoute.set(found.route, session.id)
      session.timer = setTimeout(() => end(session, 'failed', { reason: 'timeout' }), timeoutMs)
      session.timer.unref?.()
      if (login === undefined) await startTerminal(session, found, { cols: Math.min(Math.max(Number(cols) || 100, 40), 300), rows: Math.min(Math.max(Number(rows) || 30, 10), 120) })
      else await startPipe(session, login, found)
      return view(session)
    },

    // The sign-in once it has moved past `version`, or as it is after a while.
    async wait({ loginId, version = -1, waitMs = WAIT_MAX_MS } = {}) {
      const session = sessionOf(loginId)
      if (session.version <= Number(version) && !finished(session)) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(Math.max(Number(waitMs) || 0, 0), WAIT_MAX_MS))
          session.waiters.push(() => { clearTimeout(timer); resolve() })
        })
      }
      return view(session)
    },

    // A code or a callback address the user pasted from the browser.
    async input({ loginId, text } = {}) {
      const session = sessionOf(loginId)
      if (finished(session) || session.kind !== 'pipe' || session.paste === undefined || !session.running) throw new Error('This sign-in is not waiting for a code.')
      const value = String(text ?? '').trim()
      if (value === '' || value.length > PASTE_MAX) throw new Error('Paste the code or the address the browser shows.')
      if (PASTED_CODE.test(value) && session.paste === 'code') {
        session.child.stdin.write(`${value}\n`)
        return view(session)
      }
      let pasted
      try { pasted = new URL(value) } catch {}
      if (pasted !== undefined && (session.paste === 'code' || session.paste === 'callback')) {
        if (pasted.protocol !== 'http:' || !LOOPBACK.has(pasted.hostname) || session.callbackPort === undefined ||
            Number(pasted.port) !== session.callbackPort || !pasted.searchParams.has('code')) {
          throw new Error('That address is not this sign-in\'s callback.')
        }
        // The CLI listens on this computer's loopback; the browser that ended there
        // may be on another one, so its address is replayed here.
        // "localhost" is IPv4 or IPv6 depending on how the CLI bound it.
        for (const host of ['127.0.0.1', '[::1]']) {
          const response = await fetch(`http://${host}:${session.callbackPort}${pasted.pathname}${pasted.search}`,
            { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
          if (response === undefined) continue
          await response.body?.cancel().catch(() => {})
          return view(session)
        }
        throw new Error('The CLI did not take the callback. Start the sign-in again.')
      }
      throw new Error('Paste the code or the address the browser shows.')
    },

    // "I have signed in": the CLI's own check decides.
    async check({ loginId } = {}) {
      const session = sessionOf(loginId)
      if (finished(session)) return view(session)
      const result = await confirm(session, { manual: true })
      if (result === false) throw new Error('The CLI still says it is not signed in.')
      return view(session)
    },

    cancel({ loginId } = {}) {
      const session = sessions.get(String(loginId ?? ''))
      if (session !== undefined) end(session, 'canceled')
      return session === undefined ? null : view(session)
    },

    // The pseudo-terminal of a 'terminal' sign-in.
    terminalOf(loginId) {
      const session = sessionOf(loginId)
      if (session.terminalId === undefined || session.service === undefined) throw new Error('This sign-in has no terminal.')
      return { service: session.service, terminalId: session.terminalId }
    },

    viewOf: loginId => view(sessionOf(loginId)),

    async dispose() {
      disposed = true
      for (const session of sessions.values()) end(session, 'canceled')
      sessions.clear()
    },
  }
}
