// What the local agent sign-in panel (local-sign-in.js) shows, apart from React:
// which routes it can sign in, and the step a sign-in view from the host is at.
import { ENGINES } from '../../host/team-runtime/core/local-agents/engines.js'
import { t } from './i18n.js'

export const ACTIVE = new Set(['starting', 'waiting', 'verifying', 'exited'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// Whether this page runs on the computer the host runs on: a browser here can
// finish a sign-in whose link comes back to the CLI's loopback address.
export const pageIsLocal = (location = globalThis.location) => LOOPBACK.has(location?.hostname ?? '') || /\.localhost$/u.test(location?.hostname ?? '')

// A route the panel can sign in: a built-in local agent with a sign-in, not a custom
// ACP agent (the host knows no sign-in for it) or a sandbox account (Settings signs
// those in).
export const signInRoute = route => typeof route === 'string' && Object.hasOwn(ENGINES, route) && Boolean(ENGINES[route].login?.length || ENGINES[route].signIn)
export const agentName = route => (Object.hasOwn(ENGINES, route) ? ENGINES[route].name : undefined)
export const signInCommand = route => (Object.hasOwn(ENGINES, route) ? ENGINES[route].signIn : undefined)

// The words for a sign-in that ended without one.
export function signInFailure(error, name) {
  switch (error?.reason) {
    case 'timeout': return t('The sign-in took too long and was stopped.')
    case 'still-signed-out': return t('{agent} finished, but still says it is not signed in.', { agent: name })
    case 'outdated': return t('This version of {agent} cannot sign in this way. Update it, then try again.', { agent: name })
    case 'spawn': return t('{agent} could not start.', { agent: name })
    case 'no-terminal': return t('This DSH cannot open a terminal for the sign-in.')
    case 'unsupported': return t('Godbot cannot run this sign-in. Use the command below in a terminal.')
    default: return t('{agent} could not sign in.', { agent: name })
  }
}

// What the panel shows for a sign-in view from the host: the link to open and the
// way back, or the terminal.
export function signInStep(view, { local = pageIsLocal() } = {}) {
  if (view === null || view === undefined) return { kind: 'starting' }
  if (view.state === 'done') return { kind: 'done', verified: view.verified !== false }
  if (view.state === 'failed') return { kind: 'failed', error: view.error }
  if (view.state === 'canceled') return { kind: 'canceled' }
  if (view.kind === 'terminal') return { kind: 'terminal', exited: view.state === 'exited', verifying: view.state === 'verifying' }
  if (view.state === 'starting') return { kind: 'starting' }
  if (view.code !== undefined) return { kind: 'device', link: view.url, code: view.code, verifying: view.state === 'verifying' }
  // A browser on this computer returns to the CLI on its own; another one shows a
  // code (or lands on an address that does not load) to bring back here.
  const auto = local && view.autoUrl !== undefined
  return { kind: 'link', link: auto ? view.autoUrl : (view.url ?? view.autoUrl), auto, paste: view.paste, verifying: view.state === 'verifying' }
}
