import { createElement as h, useEffect, useRef, useState } from 'react'
import { NewSessionIcon } from './icons.js'
import { currentPart } from './text.js'
import { t } from './i18n.js'

// A New session starts a fresh conversation in a Bot's own chat (parts.js newPart). The
// host says where it stands (`roster.newSessions`): 'opening' while a fresh part is on
// its way, 'empty' while nobody has talked in the current part, so another one would
// only add an empty session. Anything else is 'ready'. Null where a New session does
// not apply: no Bot, a team this window may only read, or a view on another part.
export function newSessionState(roster, bot, sessionId = undefined) {
  if (bot === undefined || bot === null || roster.readOnly) return null
  if (sessionId !== undefined && currentPart(bot) !== sessionId) return null
  const state = roster.newSessions?.[bot.id]
  return state === 'opening' || state === 'empty' ? state : 'ready'
}

// The state a button shows, and the request. A click waits for the host's answer before
// it can ask again: the host turns a second ask away as well, but a button that looks
// live in the meantime invites one.
export function useNewSession(bot, roster, actions, sessionId) {
  const [pending, setPending] = useState(false)
  // A second click can land before the first one's render: the ref turns it away.
  const asking = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const state = newSessionState(roster, bot, sessionId)
  const shown = state === 'ready' && pending ? 'opening' : state
  const start = () => {
    if (shown !== 'ready' || asking.current) return
    asking.current = true
    setPending(true)
    void Promise.resolve()
      .then(() => actions.newPart(bot.id))
      .catch(error => actions.reportError?.(error, 'new-session'))
      .finally(() => {
        asking.current = false
        if (mounted.current) setPending(false)
      })
  }
  return { state: shown, start }
}

// The New session button: labelled and tinted in the chat's top bar ('bar'), a full row
// above the session list in the details panel ('panel'). DSH's own shortcuts already
// hold the usual keys (⇧⌘O opens the workspace in an app on the web), so it has none.
export function NewSessionButton({ bot, roster, actions, sessionId, variant = 'bar' }) {
  const { state, start } = useNewSession(bot, roster, actions, sessionId)
  if (state === null) return null
  const opening = state === 'opening'
  const hint = opening ? t('Starting a new session…')
    : state === 'empty' ? t('This is already a new session. Send a message to begin.')
      : t('Start a new session with {name}', { name: bot.name })
  return h('button', {
    type: 'button', className: `bt-new-session bt-new-session-${variant}`, 'data-state': state,
    'aria-disabled': state === 'ready' ? undefined : true,
    'aria-label': opening ? t('Starting a new session…') : t('New session'), title: hint,
    onClick: start,
  },
  opening ? h('span', { className: 'bt-new-session-spin', 'aria-hidden': true }) : h(NewSessionIcon),
  h('span', { className: 'bt-new-session-label' }, opening ? t('Starting…') : t('New session')))
}
