import { Fragment, createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './chat-ui.js'
import { GodbotModal } from './modal.js'
import { BrowserTeachingPanel } from './browser-teaching.js'
import style from './browser-viewer.css'

const surfaceNames = { local: '服务器浏览器', container: '独立容器', cloud: '云端容器' }
const button = (label, onClick, disabled = false, primary = false) =>
  h('button', { type: 'button', className: primary ? 'gb-modal-primary' : undefined, onClick, disabled }, label)
const remoteKeys = new Set(['Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'])

function BrowserPanel({ client, bot, sessionId, close, sharedLease }) {
  const ownLease = useRef()
  const lease = sharedLease ?? ownLease
  const alive = useRef(false)
  const [available, setAvailable] = useState([])
  const [target, setTarget] = useState('local')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [frame, setFrame] = useState()
  const [surface, setSurface] = useState('browser')
  const [input, setInput] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const call = useCallback((action, values) => client.dispatch({ action: 'browser.' + action, botId: bot.id, sessionId, ...values }), [client, bot.id, sessionId])
  useEffect(() => {
    alive.current = true
    call('status').then(value => {
      if (!alive.current) return
      setAvailable(value.targets)
      setTarget(value.target)
      setOpen(value.open)
    }, e => { if (alive.current) setError(e.message) })
    return () => {
      alive.current = false
      if (!sharedLease && lease.current) void call('release', { lease: lease.current }).catch(() => {})
      if (!sharedLease) lease.current = undefined
    }
  }, [call, lease, sharedLease])
  useEffect(() => {
    if (!open) return
    let stop = false, timer
    async function poll() {
      try {
        const sentLease = lease.current
        const value = await call('frame', { lease: sentLease, surface })
        if (!stop) {
          setFrame(value)
          if (lease.current === sentLease && value.control !== 'mine' && value.control !== 'pending') lease.current = undefined
        }
      } catch (e) {
        if (!stop && !e.message.includes('页面正在切换')) {
          setError(e.message)
          setFrame(undefined)
          setOpen(false)
          lease.current = undefined
          return
        }
      }
      if (!stop) timer = setTimeout(poll, 550)
    }
    void poll()
    return () => { stop = true; clearTimeout(timer) }
  }, [open, call, surface])
  const perform = async work => {
    setBusy(true); setError('')
    try { await work() } catch (e) { if (alive.current) setError(e.message) }
    finally { if (alive.current) setBusy(false) }
  }
  const controllable = frame?.control === 'mine' && lease.current && !busy
  const send = (data, afterSend) => perform(async () => {
    await call('input', { lease: lease.current, frameId: frame.frameId, surface: frame.surface, ...data })
    afterSend?.()
  })
  const openEnvironment = () => perform(async () => {
    await call('open', { target })
    if (alive.current) setOpen(true)
  })
  const closeEnvironment = () => perform(async () => {
    await call('close', { lease: lease.current })
    lease.current = undefined
    setOpen(false)
    setFrame(undefined)
  })
  const takeControl = () => perform(async () => {
    const value = await call('take')
    lease.current = value.lease
  })
  const releaseControl = () => perform(async () => {
    await call('release', { lease: lease.current })
    lease.current = undefined
  })
  const state = {
    mine: '你正在控制',
    other: '另一个页面正在控制',
    pending: '等待当前 Bot 操作结束',
    handoff: 'Bot 请求你接手',
    agent: frame?.expired ? '接管已过期，Bot 可继续' : 'Bot 可操作',
  }
  const frameTitle = frame?.title || frame?.url
  return h(GodbotModal,
    {
      title: bot.name + ' 的网页浏览器', close, closeLabel: '关闭面板', wide: true,
      headerAside: frame && h('span', { className: 'gb-browser-status', role: 'status' }, state[frame.control]),
    },
    h('style', null, style),
    error && h('p', { className: 'gb-modal-note', role: 'alert' }, error),
    !open && h('div', { className: 'gb-modal-actions' },
      h('select', {
        'aria-label': '浏览器执行环境', value: target, disabled: busy || !available.length,
        onChange: e => setTarget(e.target.value),
      }, available.map(value => h('option', { key: value, value }, surfaceNames[value]))),
      button('打开执行环境', openEnvironment, busy || !available.length, true)),
    open && h('div', { className: 'gb-browser-viewer' },
      h('div', { className: 'gb-modal-actions' },
        h('span', { className: 'gb-browser-title', title: frameTitle }, frameTitle || '正在读取画面'),
        ['container', 'cloud'].includes(target) && h('select', {
          'aria-label': '远程视图', value: surface,
          onChange(e) {
            setFrame(undefined)
            setSurface(e.target.value)
          },
        }, h('option', { value: 'browser' }, '网页'), h('option', { value: 'desktop' }, '完整桌面')),
        lease.current
          ? button('交还给 Bot', releaseControl, busy)
          : button('接管网页', takeControl, busy || !frame || frame.control === 'other', true),
        button('关闭执行环境', closeEnvironment, busy || frame?.control === 'other')),
      frame && h('img', {
        src: 'data:image/jpeg;base64,' + frame.data, alt: frame.surface === 'desktop' ? '实时桌面画面' : '实时浏览器画面',
        draggable: false, className: 'gb-browser-frame', 'data-controllable': controllable ? '' : undefined,
        tabIndex: controllable ? 0 : -1,
        onClick(e) {
          if (!controllable) return
          const rect = e.currentTarget.getBoundingClientRect()
          e.currentTarget.focus()
          void send({ kind: 'click', x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height })
        },
        onKeyDown(e) {
          if (!controllable || e.ctrlKey || e.metaKey || e.altKey || !remoteKeys.has(e.key)) return
          e.preventDefault()
          void send({ kind: 'key', key: e.key })
        },
        onWheel(e) {
          if (controllable) void send({ kind: 'scroll', delta: Math.max(-1200, Math.min(1200, e.deltaY)) })
        },
      }),
      frame?.control === 'mine' && h('div', { className: 'gb-browser-inputs' },
        frame.surface === 'browser' && h('input', {
          type: 'url', 'aria-label': '网页地址', placeholder: 'https://', value: address, onChange: e => setAddress(e.target.value),
        }),
        frame.surface === 'browser' && button('打开地址', () => send({ kind: 'navigate', url: address }), !controllable || !address),
        h('input', {
          type: 'password', autoComplete: 'off', 'aria-label': '输入到当前网页的内容', value: input, onChange: e => setInput(e.target.value),
        }),
        button('输入到网页', () => send({ kind: 'text', text: input }, () => setInput('')), !controllable || !input))),
    h(BrowserTeachingPanel, { call, lease: lease.current, canRecord: Boolean(controllable && frame.surface === 'browser'), recording: frame?.recording }))
}

export function WebBrowserButton({ client, bot, sessionId }) {
  const [shown, setShown] = useState(false)
  return h(Fragment, null,
    h('button', { type: 'button', className: 'bt-icon-btn bt-head-search', 'aria-label': '打开网页浏览器', title: '打开网页浏览器', onClick: () => setShown(true) }, h(Icon, { name: 'globe', size: 17 })),
    shown && h(BrowserPanel, { client, bot, sessionId, close: () => setShown(false) }))
}

export function BrowserDrawerPane({ client, bot, sessionId, roster, actions }) {
  const lease = useRef()
  const alive = useRef(false)
  const [available, setAvailable] = useState([])
  const [target, setTarget] = useState('local')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [frame, setFrame] = useState()
  const [surface, setSurface] = useState('browser')
  const [input, setInput] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  const call = useCallback((action, values) => client.dispatch({ action: 'browser.' + action, botId: bot.id, sessionId, ...values }), [client, bot.id, sessionId])

  useEffect(() => {
    alive.current = true
    call('status').then(value => {
      if (!alive.current) return
      setAvailable(value.targets?.length ? value.targets : ['local'])
      setTarget(value.target ?? 'local')
      setOpen(Boolean(value.open))
    }, e => { if (alive.current) setError(e.message) })
    return () => {
      alive.current = false
      if (lease.current) void call('release', { lease: lease.current }).catch(() => {})
      lease.current = undefined
    }
  }, [call])

  useEffect(() => {
    if (!open) return
    let stop = false, timer
    async function poll() {
      try {
        const sentLease = lease.current
        const value = await call('frame', { lease: sentLease, surface })
        if (!stop) {
          setFrame(value)
          if (lease.current === sentLease && value.control !== 'mine' && value.control !== 'pending') lease.current = undefined
        }
      } catch (e) {
        if (!stop && !e.message?.includes('页面正在切换')) {
          setError(e.message)
          setFrame(undefined)
          setOpen(false)
          lease.current = undefined
          return
        }
      }
      if (!stop) timer = setTimeout(poll, 600)
    }
    void poll()
    return () => { stop = true; clearTimeout(timer) }
  }, [open, call, surface])

  const perform = async work => {
    setBusy(true); setError('')
    try { await work() } catch (e) { if (alive.current) setError(e.message) }
    finally { if (alive.current) setBusy(false) }
  }

  const controllable = frame?.control === 'mine' && lease.current && !busy
  const send = (data, afterSend) => perform(async () => {
    await call('input', { lease: lease.current, frameId: frame?.frameId, surface: frame?.surface, ...data })
    afterSend?.()
  })
  const openEnvironment = () => perform(async () => {
    await call('open', { target })
    if (alive.current) setOpen(true)
  })
  const closeEnvironment = () => perform(async () => {
    await call('close', { lease: lease.current })
    lease.current = undefined
    setOpen(false)
    setFrame(undefined)
  })
  const takeControl = () => perform(async () => {
    const value = await call('take')
    lease.current = value.lease
  })
  const releaseControl = () => perform(async () => {
    await call('release', { lease: lease.current })
    lease.current = undefined
  })

  const state = {
    mine: '你正在控制',
    other: '另一个页面正在控制',
    pending: '等待当前 Bot 操作结束',
    handoff: 'Bot 请求你接手',
    agent: frame?.expired ? '接管已过期，Bot 可继续' : 'Bot 可操作',
  }

  const frameTitle = frame?.title || frame?.url

  return h('div', { className: 'gb-browser-drawer-pane' },
    h('style', null, style),
    error && h('p', { className: 'gb-modal-note', role: 'alert' }, error),
    h('div', { className: 'gb-browser-section' },
      h('div', { className: 'gb-browser-row gb-browser-row-head' },
        h('span', { className: 'gb-browser-label' }, '浏览器执行环境'),
        h('span', { className: `gb-browser-status-tag ${open ? 'gb-status-open' : 'gb-status-closed'}` },
          open ? (frame ? (state[frame.control] ?? '运行中') : '正在运行') : '未开启')),
      !open ? [
        h('div', { key: 'env-pick', className: 'gb-browser-row' },
          h('span', { className: 'gb-browser-label' }, '环境目标'),
          h('select', {
            className: 'bt-select',
            'aria-label': '浏览器执行环境', value: target, disabled: busy || !available.length,
            onChange: e => setTarget(e.target.value),
          }, (available.length ? available : ['local']).map(value => h('option', { key: value, value }, surfaceNames[value] ?? value)))),
        h('div', { key: 'actions', className: 'gb-browser-actions' },
          button('打开执行环境', openEnvironment, busy, true)),
        h('p', { key: 'desc', className: 'bt-browser-note', style: { margin: 0 } },
          `${bot.name} 专属浏览器使用独立 Cookie 和登录状态。开启后 Bot 可自主浏览网页与截图，遇到登录或验证码时可随时接管。`),
      ] : [
        h('div', { key: 'live-actions', className: 'gb-browser-actions' },
          lease.current
            ? button('交还给 Bot', releaseControl, busy)
            : button('接管网页', takeControl, busy || !frame || frame.control === 'other', true),
          button('放大窗口', () => setModalOpen(true), busy),
          button('关闭环境', closeEnvironment, busy || frame?.control === 'other')),
        frameTitle ? h('div', { key: 'title', className: 'gb-browser-url-bar' },
          h('span', { className: 'gb-browser-title', title: frame.url }, frameTitle)) : null,
        frame?.data ? h('div', { key: 'screen', className: 'gb-browser-frame-wrap' },
          h('img', {
            src: 'data:image/jpeg;base64,' + frame.data,
            alt: '实时浏览器画面',
            draggable: false,
            className: 'gb-browser-frame',
            'data-controllable': controllable ? '' : undefined,
            tabIndex: controllable ? 0 : -1,
            onClick(e) {
              if (!controllable) return
              const rect = e.currentTarget.getBoundingClientRect()
              e.currentTarget.focus()
              void send({ kind: 'click', x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height })
            },
            onKeyDown(e) {
              if (!controllable || e.ctrlKey || e.metaKey || e.altKey || !remoteKeys.has(e.key)) return
              e.preventDefault()
              void send({ kind: 'key', key: e.key })
            },
            onWheel(e) {
              if (controllable) void send({ kind: 'scroll', delta: Math.max(-1200, Math.min(1200, e.deltaY)) })
            },
          })) : null,
        controllable ? h('div', { key: 'inputs', className: 'gb-browser-inputs' },
          h('input', {
            type: 'url', 'aria-label': '网页地址', placeholder: 'https://', value: address, onChange: e => setAddress(e.target.value),
          }),
          button('打开', () => send({ kind: 'navigate', url: address }), !controllable || !address),
          h('input', {
            type: 'password', autoComplete: 'off', 'aria-label': '输入到当前网页的内容', value: input, onChange: e => setInput(e.target.value),
          }),
          button('输入', () => send({ kind: 'text', text: input }, () => setInput('')), !controllable || !input)) : null,
        h(BrowserTeachingPanel, { key: 'teaching', call, lease: lease.current, canRecord: Boolean(controllable && frame?.surface === 'browser'), recording: frame?.recording }),
      ]),
    modalOpen ? h(BrowserPanel, { client, bot, sessionId, sharedLease: lease, close: () => setModalOpen(false) }) : null)
}
