import { createElement as h, useEffect, useRef, useState } from 'react'

import { m } from './machine-copy.js'

export function MachineDesktop({
  rpc,
  session,
  onEnd,
  control,
  requestControl,
  canControl,
  relayOnly,
  targetName,
  disconnect,
  permissionHint,
}) {
  const video = useRef(null),
    stage = useRef(null),
    toolbar = useRef(null),
    channel = useRef(null),
    mediaPeer = useRef(null),
    decoded = useRef(false),
    generation = useRef(0),
    allowed = useRef(false)
  const [displays, setDisplays] = useState([]),
    [selected, select] = useState(''),
    [media, setMedia] = useState('Connecting to display…')
  const [path, setPath] = useState(null),
    [zoom, setZoom] = useState(1),
    [full, setFull] = useState(false)
  const [details, setDetails] = useState(false),
    [text, setText] = useState(''),
    [quality, setQuality] = useState('balanced')
  allowed.current = control
  useEffect(() => {
    let active = true
    rpc('desktop.displays', {})
      .then(({ displays: list }) => {
        if (!active) return
        if (!list.length) {
          onEnd('No graphical display is available')
          return
        }
        setDisplays(list)
        select(list[0].id)
      })
      .catch((e) => {
        if (active) onEnd(e.message)
      })
    return () => {
      active = false
    }
  }, [rpc, onEnd])
  const display = displays.find((item) => item.id === selected)
  useEffect(() => {
    if (!display) return
    const iceServers = session.iceServers || []
    const hasTURN = iceServers.some((server) => [server.urls].flat().some((url) => /^turns?:/i.test(url)))
    if (relayOnly && !hasTURN) {
      setMedia('Waiting for TURN credentials from the computer')
      setPath(null)
      const wait = setTimeout(
        () => onEnd(m('TURN is unavailable. Configure TURN on the computer or turn off Require TURN.')),
        12000,
      )
      return () => clearTimeout(wait)
    }
    const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: relayOnly ? 'relay' : 'all',
      }),
      target = video.current
    mediaPeer.current = pc
    decoded.current = false
    const gen = ++generation.current,
      localCandidates = [],
      remoteCandidates = []
    let live = true,
      offered = false,
      hasAnswer = false,
      tail = Promise.resolve(),
      cursor = 0,
      firstFrameTimer,
      frameCallback,
      previousVideo
    setMedia(display.id === 'portal' ? 'Select a screen on the Linux computer' : 'Connecting to display…')
    setPath(null)
    setZoom(1)
    function fail(error) {
      if (live) {
        live = false
        decoded.current = false
        target.srcObject = null
        onEnd(error.message || String(error))
      }
    }
    const signal = (signal) => {
      tail = tail.then(() => {
        if (live)
          return rpc('desktop.signal', {
            displayId: display.id,
            generation: gen,
            ...(signal.type === 'offer' && { quality }),
            signal,
          })
      })
      return tail
    }
    const dc = pc.createDataChannel('godbot-input-v1', { ordered: true })
    channel.current = dc
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.ontrack = (e) => {
      if (live) target.srcObject = e.streams[0] || new MediaStream([e.track])
    }
    const firstFrame = () => {
      if (!live || !target.videoWidth) return
      decoded.current = true
      clearTimeout(firstFrameTimer)
      setMedia('Live desktop')
    }
    if (target.requestVideoFrameCallback) frameCallback = target.requestVideoFrameCallback(firstFrame)
    else target.onplaying = firstFrame
    pc.onicecandidate = (e) => {
      if (!live || !e.candidate) return
      const candidate = { type: 'candidate', candidate: e.candidate.toJSON() }
      if (offered) void signal(candidate).catch(fail)
      else localCandidates.push(candidate)
    }
    pc.onconnectionstatechange = () => {
      if (!live) return
      // Trickle ICE can briefly report failure before the first nominated pair.
      // The first-frame deadline bounds startup. A loss after streaming ends access immediately.
      const state = pc.connectionState
      if (state === 'closed' || (decoded.current && (state === 'failed' || state === 'disconnected'))) {
        fail(new Error('Desktop connection ended'))
      }
    }
    async function negotiate() {
      await pc.setLocalDescription(await pc.createOffer())
      if (!live) return
      await signal({ type: 'offer', sdp: pc.localDescription.sdp })
      if (!live) return
      offered = true
      setMedia('Connecting to display…')
      firstFrameTimer = setTimeout(() => {
        if (!decoded.current) fail(new Error('The host did not deliver a desktop frame'))
      }, 25000)
      for (const candidate of localCandidates) await signal(candidate)
      while (live) {
        const result = await rpc('desktop.poll', { generation: gen, cursor, waitMs: 1000 })
        if (!live) return
        cursor = result.cursor
        for (const value of result.signals) {
          if (value.type === 'answer' && !hasAnswer) {
            await pc.setRemoteDescription({ type: 'answer', sdp: value.sdp })
            hasAnswer = true
            for (const candidate of remoteCandidates) await pc.addIceCandidate(candidate)
          } else if (value.type === 'candidate' && value.candidate) {
            if (hasAnswer) await pc.addIceCandidate(value.candidate)
            else remoteCandidates.push(value.candidate)
          }
        }
      }
    }
    const metrics = setInterval(async () => {
      if (pc.connectionState !== 'connected') return
      try {
        const stats = await pc.getStats()
        const transport = [...stats.values()].find((x) => x.type === 'transport' && x.selectedCandidatePairId)
        const pair =
          stats.get(transport?.selectedCandidatePairId) ||
          [...stats.values()].find((x) => x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded')
        const video = [...stats.values()].find((x) => x.type === 'inbound-rtp' && x.kind === 'video')
        if (!live || !pair) return
        const relay = [pair.localCandidateId, pair.remoteCandidateId].some(
          (id) => stats.get(id)?.candidateType === 'relay',
        )
        const elapsed = video?.timestamp - previousVideo?.timestamp
        const received = video?.bytesReceived - previousVideo?.bytesReceived
        const sameStream = video?.id && video.id === previousVideo?.id
        const kbps =
          sameStream && Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(received) && received >= 0
            ? Math.round((received * 8) / elapsed)
            : undefined
        if (!sameStream || elapsed > 0) previousVideo = video
        const drops = video?.framesDropped
        setPath({
          Transport: relay ? 'TURN relay' : 'Direct',
          Resolution: video?.frameWidth && video.frameWidth + ' × ' + video.frameHeight,
          'Frame rate': Number.isFinite(video?.framesPerSecond) && video.framesPerSecond + ' fps',
          'Video bitrate': kbps === undefined ? undefined : kbps + ' kbps',
          'Dropped frames': Number.isSafeInteger(drops) && drops >= 0 ? String(drops) : undefined,
          'Round-trip time':
            Number.isFinite(pair.currentRoundTripTime) && Math.round(pair.currentRoundTripTime * 1000) + ' ms',
          Codec: stats.get(video?.codecId)?.mimeType,
        })
      } catch {}
    }, 1500)
    void negotiate().catch(fail)
    return () => {
      live = false
      clearInterval(metrics)
      clearTimeout(firstFrameTimer)
      if (frameCallback !== undefined) target.cancelVideoFrameCallback(frameCallback)
      decoded.current = false
      mediaPeer.current = null
      dc.close()
      pc.close()
      target.onplaying = null
      target.srcObject = null
      channel.current = null
    }
  }, [display, rpc, onEnd, session.sessionId, session.iceGeneration, relayOnly, quality])
  function input(type, data = {}) {
    const dc = channel.current
    if (
      !allowed.current ||
      !decoded.current ||
      mediaPeer.current?.connectionState !== 'connected' ||
      !display ||
      dc?.readyState !== 'open'
    )
      return
    if (type === 'move' && dc.bufferedAmount > 16384) return
    dc.send(JSON.stringify({ type, displayId: display.id, revision: display.revision, ...data }))
  }
  function point(e) {
    const node = video.current,
      box = node.getBoundingClientRect()
    if (!node.videoWidth || !box.width) return null
    const scale = Math.min(box.width / node.videoWidth, box.height / node.videoHeight)
    const w = node.videoWidth * scale,
      h = node.videoHeight * scale
    const x = (e.clientX - box.left - (box.width - w) / 2) / w,
      y = (e.clientY - box.top - (box.height - h) / 2) / h
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
  }
  function pointer(e, type, down) {
    if (!control) return
    if (!(type === 'button' && down) && document.activeElement !== video.current) return
    const p = point(e)
    if (!p) {
      if (type === 'button' && !down) input('reset')
      return
    }
    if (type === 'button' && down) {
      e.currentTarget.focus()
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    e.preventDefault()
    input(type, { ...p, ...(type === 'button' ? { button: e.button, down } : {}) })
  }
  function key(e, down) {
    if (!control || e.isComposing) return
    if (e.code === 'Escape' || (e.code === 'Space' && e.ctrlKey && e.altKey)) {
      e.preventDefault()
      e.stopPropagation()
      input('reset')
      toolbar.current?.focus()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    input('key', { code: e.code, down })
  }
  useEffect(() => {
    const node = video.current
    const scroll = (e) => {
      if (!control || document.activeElement !== node) return
      const p = point(e)
      if (!p) return
      e.preventDefault()
      input('wheel', { ...p, dx: e.deltaX, dy: e.deltaY })
    }
    const blur = () => {
      input('reset')
      if (document.activeElement === node) toolbar.current?.focus()
    }
    node.addEventListener('wheel', scroll, { passive: false })
    window.addEventListener('blur', blur)
    return () => {
      node.removeEventListener('wheel', scroll)
      window.removeEventListener('blur', blur)
    }
  }, [control, display])
  useEffect(() => {
    const f = () => setFull(document.fullscreenElement === stage.current)
    document.addEventListener('fullscreenchange', f)
    return () => document.removeEventListener('fullscreenchange', f)
  }, [])
  return h(
    'section',
    { className: 'gb-machine-desktop', ref: stage },
    h(
      'div',
      { className: 'gb-machine-bar' },
      full && h('strong', null, targetName),
      h('strong', { role: 'status' }, m(media)),
      (media === 'Select a screen on the Linux computer' ||
        media === 'Waiting for TURN credentials from the computer') &&
        h('button', { onClick: () => onEnd(m('Request canceled')) }, m('Cancel request')),
      h(
        'select',
        { 'aria-label': m('Display'), value: selected, onChange: (e) => select(e.target.value) },
        displays.map((d) => h('option', { key: d.id, value: d.id }, d.name)),
      ),
      h(
        'select',
        { 'aria-label': m('Zoom'), value: zoom, onChange: (e) => setZoom(+e.target.value) },
        [1, 1.5, 2].map((x) => h('option', { key: x, value: x }, x === 1 ? m('Fit') : x + '×')),
      ),
      h(
        'button',
        {
          disabled: !document.fullscreenEnabled,
          onClick: () => {
            void (full ? document.exitFullscreen() : stage.current.requestFullscreen()).catch(() => {})
          },
        },
        full ? m('Exit fullscreen') : m('Fullscreen'),
      ),
    ),
    h(
      'div',
      { className: 'gb-machine-video-window' },
      h('video', {
        ref: video,
        muted: true,
        autoPlay: true,
        playsInline: true,
        tabIndex: 0,
        'aria-label': m('Remote desktop'),
        style: { width: zoom * 100 + '%', height: zoom * 100 + '%' },
        onContextMenu: (e) => e.preventDefault(),
        onPointerDown: (e) => pointer(e, 'button', true),
        onPointerUp: (e) => pointer(e, 'button', false),
        onPointerMove: (e) => pointer(e, 'move'),
        onPointerCancel: () => input('reset'),
        onKeyDown: (e) => key(e, true),
        onKeyUp: (e) => key(e, false),
        onBlur: () => input('reset'),
      }),
    ),
    h(
      'div',
      { className: 'gb-machine-bar' },
      h('strong', { role: 'status' }, control ? m('You have control') : m('View only')),
      h('button', { ref: toolbar, onClick: () => setDetails(!details) }, m('Session details')),
      h(
        'button',
        {
          className: 'gb-machine-primary',
          onClick: requestControl,
          disabled: !control && !session.controlPending && (!canControl || media !== 'Live desktop'),
          title: !canControl ? permissionHint || m('The target has not granted OS input permission') : undefined,
        },
        control
          ? m('Release control')
          : session.controlPending
            ? m('Cancel control request')
            : m('Request control'),
      ),
      full && h('button', { type: 'button', onClick: disconnect }, m('Disconnect')),
    ),
    !canControl && h('p', null, permissionHint || m('The target has not granted OS input permission')),
    control &&
      h('p', null, m('Click the desktop to operate it. Escape or Ctrl+Alt+Space returns to the toolbar.')),
    session.controlReason === 'INPUT_DENIED' &&
      !control &&
      !session.controlPending &&
      h('p', { role: 'status' }, m('Control declined on the computer. You can keep viewing.')),
    session.controlPending &&
      h(
        'p',
        { role: 'status' },
        m(
          session.controlPrompt === 'system'
            ? 'Approve keyboard and pointer sharing in the system dialog on the computer'
            : 'Waiting for input approval on the computer',
        ),
      ),
    details &&
      h(
        'div',
        { className: 'gb-machine-details' },
        h(
          'dl',
          { className: 'gb-machine-stats' },
          ...[
            'Transport', 'Resolution', 'Frame rate', 'Video bitrate', 'Dropped frames', 'Round-trip time', 'Codec',
          ].flatMap((label) => {
            const value = path?.[label]
            const displayValue = label === 'Transport' && value ? m(value) : value
            return [
              h('dt', { key: label }, m(label)),
              h('dd', { key: label + '-value' }, displayValue || m('Not available')),
            ]
          }),
        ),
        h(
          'label',
          null,
          m('Stream quality'),
          ' ',
          h(
            'select',
            { value: quality, onChange: (e) => setQuality(e.target.value) },
            h('option', { value: 'balanced' }, m('Balanced')),
            h('option', { value: 'low' }, m('Bandwidth saver')),
          ),
        ),
      ),
    control &&
      details &&
      h(
        'div',
        { className: 'gb-machine-bar', role: 'group', 'aria-label': m('Send shortcut') },
        h('span', null, m('Send shortcut')),
        ...[
          ['Alt+Tab', 'AltLeft', 'Tab'],
          ['Ctrl+C', 'ControlLeft', 'KeyC'],
          ['⌘+Space', 'MetaLeft', 'Space'],
        ].map(([label, modifier, code]) =>
          h(
            'button',
            {
              key: label,
              onClick: () => {
                input('key', { code: modifier, down: true })
                input('key', { code, down: true })
                input('key', { code, down: false })
                input('key', { code: modifier, down: false })
              },
            },
            label,
          ),
        ),
      ),
    control &&
      h(
        'form',
        {
          onSubmit: (e) => {
            e.preventDefault()
            if (text) {
              input('text', { text })
              setText('')
            }
          },
        },
        h('input', {
          'aria-label': m('Send composed text'),
          placeholder: m('Send composed text'),
          value: text,
          maxLength: 1024,
          onChange: (e) => setText(e.target.value),
        }),
        h('button', { className: 'gb-machine-send-text', disabled: !text }, m('Send text')),
      ),
  )
}
