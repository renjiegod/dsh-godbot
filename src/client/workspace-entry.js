import { createElement as h, useSyncExternalStore } from 'react'

function RuntimeStatus({ source, retry, navigation }) {
  const state = useSyncExternalStore(source.subscribe, source.read, source.read)
  if (!state) return null
  const waiting = state.mode === 'starting'
  return h(
    'section',
    {
      'aria-label': 'Godbot 团队',
      'data-godbot-runtime': state.mode,
      style: {
        position: 'fixed',
        zIndex: 40,
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 'min(420px,90vw)',
        padding: '20px',
        borderRadius: 16,
        background: 'var(--dsw-alias-bg-base,#fff)',
        color: 'var(--dsw-alias-label-primary,#222)',
        boxShadow: '0 6px 40px #0003',
        pointerEvents: 'auto',
      },
    },
    h('strong', null, 'Godbot 团队'),
    h('p', { role: waiting ? 'status' : 'alert' }, state.message || '正在连接团队工作台…'),
    h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      !waiting && h('button', { type: 'button', onClick: retry }, '重新连接'),
      h('button', { type: 'button', onClick: () => navigation.openManagement() }, '团队管理'),
      h('button', { type: 'button', onClick: navigation.back }, '返回 dsh'),
    ),
  )
}

/** Wait for the host runtime before mounting a team workspace in this tab. */
export function openWorkspace(ctx, client, navigation, mount) {
  let state = { mode: 'starting' },
    active = true,
    timer,
    unmount,
    generation = 0
  const listeners = new Set()
  const source = {
    read: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  function publish(update) {
    state = update
    for (const fn of listeners) fn()
  }
  const off = ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'godbot-runtime', order: 100 }, () =>
      h(RuntimeStatus, { source, navigation, retry: check }),
    ),
  )
  async function check() {
    clearTimeout(timer)
    unmount?.()
    unmount = undefined
    const token = ++generation
    publish({ mode: 'starting' })
    try {
      const result = await client.snapshot()
      if (!active || token !== generation) return
      const runtime = result.workspaceRuntime ?? {
        mode: 'unavailable',
        message: '当前 Godbot Host 尚未提供团队运行状态。',
      }
      if (runtime.mode === 'embedded') {
        unmount = mount((error) => {
          if (active) publish(error ? { mode: 'unavailable', message: error.message } : null)
        })
      } else {
        publish(runtime)
        if (runtime.mode === 'starting') timer = setTimeout(check, 1300)
      }
    } catch (error) {
      if (active && token === generation)
        publish({ mode: 'unavailable', message: error.message || String(error) })
    }
  }
  void check()
  return () => {
    active = false
    clearTimeout(timer)
    unmount?.()
    off()
    listeners.clear()
  }
}
