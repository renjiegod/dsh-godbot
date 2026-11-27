import { createElement as h, useEffect, useState } from 'react'
import { call } from './team-ui/api.js'
import { t } from './team-ui/i18n.js'

// A link into an old part must not follow the owner's currently selected chat.
export function BoardAnchor({ anchor, actions, back }) {
  const [value, setValue] = useState(null),
    [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    const match = String(anchor.messageId ?? '').match(/^(?:[a-z]+:)?(\d+)$/i)
    const common = { partId: anchor.sessionId, anchorSeq: match ? Number(match[1]) : undefined, steps: false }
    const request = anchor.roomId
      ? call('room-chat', { ...common, roomId: anchor.roomId })
      : call('chat', { ...common, botId: anchor.botId })
    request.then(
      (v) => {
        if (mounted) setValue(v)
      },
      (e) => {
        if (mounted) setError(e.message)
      },
    )
    return () => {
      mounted = false
    }
  }, [anchor])
  const lines = (value?.items ?? []).filter((i) => typeof i.text === 'string' && i.text.trim())
  const exact = lines.find((i) => anchor.messageId != null && String(i.seq ?? i.id) === String(anchor.messageId))
  const pertinent = exact ? [exact] : anchor.turnId != null ? lines.filter((i) => i.turn === anchor.turnId) : []
  return h(
    'section',
    null,
    h('h2', null, t('Source record')),
    h('p', null, anchor.sessionId || anchor.roomId),
    error ? h('p', { className: 'gb-alert', role: 'alert' }, error) : !value ? h('p', null, t('Loading…')) : null,
    ...(pertinent.length ? pertinent : lines.slice(-5)).map((i, n) => h('pre', { key: n }, i.text)),
    h(
      'footer',
      null,
      h('button', { onClick: back }, t('Back')),
      h('button', { onClick: () => actions.openWorkSession(anchor) }, t('Open conversation')),
    ),
  )
}
