// Signing a local agent CLI in from the page: the repair card of a turn that failed
// on the sign-in, Settings → Local agents and the Create Bot form all open this
// panel. The host runs the CLI's own login (sign-in.js); the panel shows its link,
// its one-time code, a box for the code the browser shows, or its terminal.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { LoginTerminal } from '../login-terminal.js'
import { call as defaultCall } from './api.js'
import { CheckIcon, CopyIcon } from './icons.js'
import { hostText, t } from './i18n.js'
import { ACTIVE, pageIsLocal, signInFailure, signInStep } from './local-sign-in-model.js'

export { agentName, pageIsLocal, signInCommand, signInRoute, signInStep } from './local-sign-in-model.js'

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text)?.then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) }).catch(() => {})
  }
  return h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-signin-copy', onClick: copy },
    copied ? h(CheckIcon) : h(CopyIcon), copied ? t('Copied') : label)
}

function PasteBox({ paste, busy, submit }) {
  const [text, setText] = useState('')
  const prompt = paste === 'callback'
    ? t('If the browser could not come back to this computer, paste the address it ended on.')
    : t('If the page shows a code, paste it here.')
  return h('form', { className: 'bt-signin-paste', onSubmit: (event) => { event.preventDefault(); if (text.trim()) void submit(text.trim()).then(ok => { if (ok) setText('') }) } },
    h('label', { className: 'bt-signin-hint' }, prompt,
      h('input', { type: 'text', value: text, autoComplete: 'off', spellCheck: false, 'aria-label': paste === 'callback' ? t('Callback address') : t('Authorization code'),
        placeholder: paste === 'callback' ? 'http://localhost:…' : t('Authorization code'), onChange: event => setText(event.target.value) })),
    h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy || text.trim() === '' }, t('Submit')))
}

const METHOD_LABELS = { device: () => t('Sign in with a one-time code'), browser: () => t('Sign in in the browser instead'), terminal: () => t('Sign in in a terminal') }

// `route` and `name` are the CLI's; `command` its sign-in command, to run by hand.
// `onDone` hears of a sign-in the CLI confirmed.
export function LocalSignInPanel({ route, name, command, onDone, onClose, call = defaultCall, local }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState({ n: 0, method: undefined })
  const current = useRef(null)
  const told = useRef(false)
  const here = local ?? pageIsLocal()

  useEffect(() => {
    const stop = new AbortController()
    let loginId
    setView(null)
    setError('')
    told.current = false
    void (async () => {
      try {
        let next = await call('local-agent-login-start', { route, ...(attempt.method ? { method: attempt.method } : {}), cols: 96, rows: 26 }, stop.signal)
        loginId = next.loginId
        while (!stop.signal.aborted) {
          current.current = next
          setView(next)
          if (!ACTIVE.has(next.state)) break
          next = await call('local-agent-login-wait', { loginId, version: next.version }, stop.signal, { quiet: true })
        }
      } catch (failure) {
        if (!stop.signal.aborted) setError(hostText(failure?.message ?? String(failure)))
      }
    })()
    return () => {
      stop.abort()
      // Leaving the panel ends a sign-in still under way: its CLI waits for no one.
      if (loginId !== undefined && ACTIVE.has(current.current?.state)) void call('local-agent-login-cancel', { loginId }, undefined, { quiet: true }).catch(() => {})
    }
  }, [route, attempt, call])

  useEffect(() => {
    if (view?.state !== 'done' || told.current) return
    told.current = true
    onDone?.(view)
  }, [view, onDone])

  const act = useCallback(async (endpoint, payload) => {
    if (!view) return false
    setBusy(true)
    setError('')
    try {
      const next = await call(endpoint, { loginId: view.loginId, ...payload })
      if (next) { current.current = next; setView(previous => (previous && previous.version > next.version ? previous : next)) }
      return true
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
      return false
    } finally { setBusy(false) }
  }, [view, call])

  const restart = method => setAttempt(previous => ({ n: previous.n + 1, method: method ?? previous.method }))
  const step = signInStep(view, { local: here })
  const others = (view?.methods ?? []).filter(method => method !== view?.method)
  const switcher = others.length > 0 && step.kind !== 'done'
    ? others.map(method => h('button', { key: method, type: 'button', className: 'bt-link-btn', onClick: () => restart(method) }, (METHOD_LABELS[method] ?? (() => method))()))
    : null
  const cancel = ACTIVE.has(view?.state) ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void act('local-agent-login-cancel') }, t('Cancel')) : null
  const manual = command ? h('details', { className: 'bt-signin-manual' },
    h('summary', null, t('Sign in in a terminal of your own')),
    h('div', { className: 'bt-signin-row' }, h('code', null, command), h(CopyButton, { text: command, label: t('Copy') }))) : null

  let body
  switch (step.kind) {
    case 'starting':
      body = h('div', { className: 'bt-signin-status', role: 'status' }, error === '' ? t('Starting the sign-in of {agent}…', { agent: name }) : null)
      break
    case 'device':
      body = [
        h('div', { key: 'say', className: 'bt-signin-hint' }, t('Open the page, sign in, and enter this one-time code.')),
        h('div', { key: 'code', className: 'bt-signin-row' },
          h('code', { className: 'bt-signin-code', 'data-signin-code': true }, step.code), h(CopyButton, { text: step.code, label: t('Copy code') })),
        h('div', { key: 'go', className: 'bt-signin-row' },
          step.link && h('a', { className: 'bt-send bt-signin-go', href: step.link, target: '_blank', rel: 'noopener noreferrer' }, t('Open the sign-in page ↗')),
          step.link && h(CopyButton, { text: step.link, label: t('Copy link') })),
        h('div', { key: 'wait', className: 'bt-signin-status', role: 'status' }, step.verifying ? t('Checking the sign-in…') : t('Waiting for you to finish in the browser…')),
      ]
      break
    case 'link':
      body = [
        h('div', { key: 'say', className: 'bt-signin-hint' }, step.auto
          ? t('Open the page and sign in. This finishes by itself when the browser is done.')
          : t('Open the page and sign in on any device.')),
        h('div', { key: 'go', className: 'bt-signin-row' },
          step.link && h('a', { className: 'bt-send bt-signin-go', href: step.link, target: '_blank', rel: 'noopener noreferrer', 'data-signin-link': step.auto ? 'auto' : 'manual' }, t('Open the sign-in page ↗')),
          step.link && h(CopyButton, { text: step.link, label: t('Copy link') })),
        step.paste && h(PasteBox, { key: 'paste', paste: step.paste, busy, submit: text => act('local-agent-login-input', { text }) }),
        h('div', { key: 'wait', className: 'bt-signin-status', role: 'status' }, step.verifying ? t('Checking the sign-in…') : t('Waiting for you to finish in the browser…')),
      ]
      break
    case 'terminal':
      body = [
        h('div', { key: 'say', className: 'bt-signin-hint' }, t('This is {agent}\'s own sign-in. Follow it below; links open with a click.', { agent: name })),
        !step.exited && view && h(LoginTerminal, { key: view.loginId, call, loginId: view.loginId, size: view.terminal ?? { cols: 96, rows: 26 }, label: t('{agent} sign-in', { agent: name }) }),
        step.exited && h('div', { key: 'exited', className: 'bt-signin-status', role: 'status' }, t('{agent} closed without confirming a sign-in.', { agent: name })),
        h('div', { key: 'go', className: 'bt-signin-row' },
          h('button', { type: 'button', className: 'bt-send bt-signin-go', disabled: busy || step.verifying, onClick: () => void act('local-agent-login-check') }, t('I have signed in')),
          step.exited && h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => restart() }, t('Start again'))),
      ]
      break
    case 'done':
      body = h('div', { className: 'bt-signin-status', 'data-signin-done': true, role: 'status' },
        step.verified ? t('{agent} is signed in.', { agent: name }) : t('{agent} finished its sign-in.', { agent: name }))
      break
    case 'failed':
      body = [
        h('div', { key: 'why', className: 'bt-signin-error', role: 'alert' }, signInFailure(step.error, name),
          step.error?.detail ? h('small', null, step.error.detail) : null),
        h('div', { key: 'go', className: 'bt-signin-row' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => restart() }, t('Try again'))),
      ]
      break
    default:
      body = [
        h('div', { key: 'why', className: 'bt-signin-status', role: 'status' }, t('The sign-in was canceled.')),
        h('div', { key: 'go', className: 'bt-signin-row' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => restart() }, t('Start again'))),
      ]
  }

  return h('section', { className: 'bt-signin', 'data-local-sign-in': route, 'data-state': view?.state ?? 'starting', 'aria-label': t('Sign in to {agent}', { agent: name }) },
    h('style', null, LOCAL_SIGN_IN_CSS),
    h('div', { className: 'bt-signin-head' },
      h('strong', null, t('Sign in to {agent}', { agent: name })),
      onClose ? h('button', { type: 'button', className: 'bt-link-btn', onClick: onClose }, step.kind === 'done' ? t('Close') : t('Hide')) : null),
    body,
    error ? h('div', { className: 'bt-signin-error', role: 'alert' }, error) : null,
    (cancel || switcher) && h('div', { className: 'bt-signin-row bt-signin-foot' }, cancel, switcher),
    step.kind !== 'done' ? manual : null)
}

export const LOCAL_SIGN_IN_CSS = `
.bt-signin{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:12px;background:var(--bt-card,transparent);box-shadow:inset 0 0 0 1px var(--bt-line,rgba(127,127,127,.25));font-size:13px;line-height:18px;color:var(--bt-ink,inherit);min-width:0}
.bt-signin-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-signin-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bt-signin-hint{color:var(--bt-ink-2,inherit);display:flex;flex-direction:column;gap:6px}
.bt-signin-status{color:var(--bt-ink-2,inherit)}
.bt-signin-error{color:var(--bt-danger,#c0392b);display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.bt-signin-error small{color:var(--bt-ink-3,inherit);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.bt-signin-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;letter-spacing:.08em;padding:4px 10px;border-radius:8px;background:var(--bt-hover,rgba(127,127,127,.12));user-select:all}
.bt-signin .bt-signin-go,.bt-signin a.bt-signin-go{display:inline-flex;align-items:center;height:28px;padding:0 12px;font-size:12px;text-decoration:none;box-sizing:border-box;color:var(--bt-accent-ink,#fff)}
.bt-signin-copy{display:inline-flex;align-items:center;gap:4px}
.bt-signin-copy svg{width:13px;height:13px}
.bt-signin-paste{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}
.bt-signin-paste label{flex:1 1 260px}
.bt-signin-paste input{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--bt-line,rgba(127,127,127,.35));background:transparent;color:inherit;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.bt-signin-term{height:300px;min-width:0;border-radius:8px;overflow:hidden;background:#111}
.bt-signin-manual summary{cursor:pointer;color:var(--bt-ink-3,inherit);font-size:12px}
.bt-signin-manual code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.bt-signin .bt-link-btn{background:none;border:0;padding:0;color:var(--bt-accent,inherit);font:inherit;font-size:12px;cursor:pointer}
`
