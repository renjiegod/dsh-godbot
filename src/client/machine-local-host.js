import { createElement as h, useEffect, useRef, useState } from 'react'
import { m } from './machine-copy.js'
import { MachineConfirmation } from './machine-confirm.js'

const button = (text, fn, props = {}) =>
  h('button', { type: 'button', onClick: fn, ...props }, m(text))

const errors = {
  status: 'Could not read host status.',
  enable: 'Could not enable remote access. Check the relay and try again.',
  disable: 'Could not turn off remote access.',
  pair: 'Could not create a pairing link.',
  'open-permissions': 'Could not open the permissions app.',
}

function hostIssue(detail, fallback) {
  const text = typeof detail === 'string' ? detail : detail?.message || ''
  if (/secure wss relay|relay path|Invalid (?:Computer Host relay|URL)/iu.test(text))
    return 'Enter a secure WebSocket relay ending in /v1/link.'
  if (text.includes('standalone foreground Computer Host'))
    return 'Stop the standalone foreground host before enabling management in Godbot.'
  if (/different login service|unrecognized Computer Host login service|Several standalone Computer Host services/iu.test(text))
    return 'Another service manages this host. Check your existing Computer Host installation.'
  if (/another publisher|signature is invalid|signed package|verified Mac video encoder|encoder verification failed/iu.test(text))
    return 'Godbot could not verify the installed host components.'
  if (text.includes('Another Godbot profile')) return 'Another Godbot profile is changing this host. Try again shortly.'
  return fallback
}

export function LocalMachineHost({ client, heading }) {
  const [host, setHost] = useState(null)
  const [relay, setRelay] = useState('')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [expires, setExpires] = useState(0)
  const [copied, setCopied] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const task = useRef(0), active = useRef(false), waiting = useRef(false), edited = useRef(false)
  const secret = useRef(null)
  function clearOffer() {
    secret.current = null
    setExpires(0)
    setCopied(false)
  }
  async function request(action, props = {}) {
    if (waiting.current) return
    waiting.current = true
    const version = ++task.current
    setPending(action)
    setError('')
    if (action === 'pair' || action === 'disable') clearOffer()
    try {
      const { offer, ...status } = await client.machineHost({ action, ...props })
      if (!active.current || version !== task.current) return
      setHost(status)
      if (!edited.current || status.enabled || status.running) {
        setRelay(status.relay || '')
        edited.current = false
      }
      if (!status.running || !status.enabled) clearOffer()
      if (action === 'pair' && !document.hidden) {
        if (typeof offer?.uri !== 'string' || !offer.uri.startsWith('godbot://computer-pair?') ||
            !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= Date.now())
          throw new Error()
        secret.current = offer
        setExpires(offer.expiresAt)
      }
    } catch (cause) {
      if (active.current && version === task.current) setError(hostIssue(cause, errors[action]))
    } finally {
      if (active.current && version === task.current) {
        waiting.current = false
        setPending('')
      }
    }
  }
  useEffect(() => {
    active.current = true
    void request('status')
    const hide = () => { if (document.hidden) clearOffer() }
    document.addEventListener('visibilitychange', hide)
    return () => {
      active.current = false
      ++task.current
      waiting.current = false
      secret.current = null
      document.removeEventListener('visibilitychange', hide)
    }
  }, [client])
  useEffect(() => {
    if (!expires) return
    const timeout = setTimeout(clearOffer, Math.max(0, expires - Date.now()))
    return () => clearTimeout(timeout)
  }, [expires])
  async function copy() {
    const offer = secret.current
    if (!offer || offer.expiresAt <= Date.now()) return clearOffer()
    try {
      await navigator.clipboard.writeText(offer.uri)
      if (active.current && secret.current === offer) {
        setCopied(true)
        setError('')
      }
    } catch {
      if (active.current && secret.current === offer) setError('Allow clipboard access in this browser and try again.')
    }
  }

  const managed = host?.enabled && host.managed !== false
  const stopping = host?.pendingAction === 'disable' || (host?.managed && !host.enabled)
  const starting = host?.pendingAction === 'enable' || (host?.enabled && host.managed === false)
  const external = host?.running && !host.managed && !starting
  const busy = !!pending
  const lifecycle = stopping ? 'Waiting to turn off remote access'
    : starting ? 'Waiting to enable remote access'
    : managed ? (host.online ? 'Online for paired devices' : host.running ? 'Connecting to the relay' : 'Host stopped')
    : external ? 'Standalone host is running' : 'Remote access is off'
  const canEnable = !stopping && !starting && (!managed || !host.running)
  return h('section', { className: 'gb-local-host', 'aria-label': m('This computer') },
    h('div', { className: 'gb-machine-title' },
      h('h3', { tabIndex: -1, ref: heading }, m('This computer')),
      button('Check again', () => request('status'), { disabled: busy })),
    error && h('p', { role: 'alert', className: 'gb-error' }, m(error)),
    !host && !error && h('p', { role: 'status' }, m('Checking…')),
    host && !host.supported && h('p', null, m('Hosting with this Godbot installation requires a Mac with Apple silicon. You can still connect to another computer.')),
    host?.supported && h('div', { className: 'gb-local-host-body' },
      h('div', { className: 'gb-machine-ready' },
        h('h4', { role: 'status' }, m(pending === 'enable' ? 'Preparing the host…'
          : pending === 'disable' ? 'Turning off remote access…' : lifecycle)),
        h('p', null, m(external
          ? 'Godbot can manage the existing host with its current relay and paired devices.'
          : 'Pair a device to request a desktop or terminal session on this Mac.')),
        h('form', {
          onSubmit: event => {
            event.preventDefault()
            if (!busy && canEnable && relay.trim())
              void request('enable', { relay: relay.trim() })
          },
        },
          h('label', null, m('Relay server'),
            h('input', { type: 'url', value: relay, required: true, readOnly: !canEnable || host.running,
              disabled: busy, autoComplete: 'off', spellCheck: false, dir: 'ltr',
              placeholder: 'wss://relay.example.org/v1/link',
              onChange: e => { edited.current = true; setRelay(e.target.value) } })),
          h('div', { className: 'gb-local-host-actions' },
            canEnable && h('button', {
              type: 'submit', disabled: busy || !relay.trim(),
              className: 'gb-machine-primary',
            }, m(external ? 'Manage with Godbot' : managed ? 'Start host' : 'Enable remote access')),
            starting && !managed && button('Cancel request', () => request('disable'), { disabled: busy }),
            managed && button('Turn off remote access', () => setConfirmOff(true), { disabled: busy }))),
        host.busy && h('small', null, m('A remote session is active or awaiting approval.')),
        host.updatePending && !starting && !stopping && h('small', null, m('A host update is pending.')),
        host.error && !error && h('p', { role: 'alert', className: 'gb-error' }, m(hostIssue(host.error, 'Godbot could not finish host setup.')))),
      managed && h('div', { className: 'gb-machine-ready' },
        h('div', { className: 'gb-machine-title' },
          h('h4', null, m('Permissions')),
          button('Open macOS permissions', () => request('open-permissions'), { disabled: busy || starting || !host.running || !host.installed })),
        h('dl', { className: 'gb-machine-stats' },
          [ ['Screen Recording', host.desktop], ['Accessibility', host.control] ].map(([label, available]) =>
            h('div', { key: label, className: 'gb-local-host-permission' },
              h('dt', null, m(label)),
              h('dd', null, m(!host.running ? 'Not checked' : available ? 'Available now' : 'Unavailable now')))))),
      managed && !starting && host.online && h('div', { className: 'gb-machine-ready' },
        h('h4', null, m('Pair another device')),
        h('p', null, m('On the other device, open Remote computers and paste the pairing link.')),
        host.fingerprint && h('p', null, m('Host fingerprint'), ' · ', h('code', null, host.fingerprint)),
        expires
          ? h('div', { className: 'gb-local-host-actions' },
              button('Copy pairing link', copy, { disabled: busy, className: 'gb-machine-primary' }),
              h('span', { role: 'status' }, copied ? m('Copied') + ' · ' : '',
                m('Expires at {time}', { time: new Date(expires).toLocaleTimeString() })))
          : button('Create pairing link', () => request('pair'), { disabled: busy, className: 'gb-machine-primary' }))),
    confirmOff && h(MachineConfirmation, { text: m('Turn off remote access? Current sessions can finish.'),
      cancel: () => setConfirmOff(false), confirm: () => { setConfirmOff(false); void request('disable') } }))
}
