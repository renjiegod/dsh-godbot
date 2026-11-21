import { workspaceHash, managementHash, legacyAgentsHash, providerSettingsHash, workspaceViews } from '../team/workspace-routes.js'

export { workspaceHash, managementHash }
export const panelId = 'dsh-godbot'
const historyKey = 'dshGodbotWorkspace'

const viewAt = hash => workspaceViews[hash] ?? null

export function mainSession(ctx) {
  return Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find((s) => s?.retainedBy?.mainView > 0)
    ?.id
}

/** The retained main Session can be absent while DSH opens a selected chat. */
export function sessionSelection({ current, onEmpty, waitMs, schedule = setTimeout, cancel = clearTimeout }) {
  let pending, timer
  let revision = 0, disposed = false

  function endOpening() {
    cancel(timer)
    timer = undefined
    pending = undefined
  }

  function canRecover(id) {
    return !disposed && (!pending || id === pending.target)
  }

  return {
    open(target, open) {
      if (disposed) return
      const requested = ++revision
      const from = current()
      const continuing = pending?.target === target
      endOpening()
      if (from !== target || continuing) {
        pending = { from, target }
        timer = schedule(() => {
          if (disposed || revision !== requested || !pending) return
          endOpening()
          if (current() == null) onEmpty()
        }, waitMs)
      }
      try {
        open(target)
      } catch (error) {
        if (revision === requested) endOpening()
        throw error
      }
    },
    observe(id) {
      if (pending && id != null && id !== pending.from && id !== pending.target) endOpening()
    },
    async recover(open, refresh) {
      const from = current()
      if (!canRecover(from)) return
      const requested = revision
      if (refresh) await refresh()
      if (canRecover(from) && revision === requested && current() === from) open()
    },
    dispose() {
      disposed = true
      endOpening()
    },
  }
}

/** The Bot product uses DSH's normal main Session. Team management is a keyed main panel.
 * Keep one browser history entry for both, including the precise place in DSH to return to. */
export function connectNavigation(ctx, browser, mountManagement, mountBot) {
  const { layout, slots } = ctx
  const selected = () => layout.panelInfo.getSnapshot().activePanelId
  const url = (hash) => browser.location.pathname + browser.location.search + hash
  let previousPanel = selected() === panelId ? null : selected()
  let previous, unmount, view
  let transition = false,
    disposed = false

  function place(pushed) {
    return {
      panel: previousPanel,
      session: mainSession(ctx),
      hash: viewAt(browser.location.hash) ? '' : browser.location.hash,
      pushed,
    }
  }
  function saveRoute(next, push) {
    const state = { ...browser.history.state, [historyKey]: previous }
    browser.history[push ? 'pushState' : 'replaceState'](
      state,
      '',
      url(next === 'bot' ? workspaceHash : managementHash),
    )
  }
  function removeRoute() {
    const state = { ...browser.history.state }
    delete state[historyKey]
    browser.history.replaceState(state, '', url(previous?.hash || ''))
  }
  function show(next, target) {
    if (disposed || (view === next && !target)) return
    transition = true
    try {
      browser.document?.documentElement.toggleAttribute('data-godbot-workspace', Boolean(next))
      unmount?.()
      unmount = undefined
      view = next
      if (next === 'management') {
        unmount = mountManagement()
        layout.selectPanel(panelId)
      } else if (next === 'bot') {
        layout.selectPanel(null)
        unmount = mountBot(target)
      }
    } finally {
      transition = false
    }
  }
  function enter(next, target) {
    if (disposed) return
    const push = !view && !viewAt(browser.location.hash)
    if (!view) previous = browser.history.state?.[historyKey] ?? place(push)
    saveRoute(next, push)
    show(next, target)
  }
  function leave(panel, restoreSession) {
    if (!view) return
    show(null)
    transition = true
    try {
      if (
        restoreSession &&
        previous?.session &&
        mainSession(ctx) !== previous.session &&
        ctx.sessions.list.getSnapshot().byId?.[previous.session]
      )
        ctx.uiWorkspace.openSession(previous.session)
      const valid =
        panel && panel !== panelId && slots.entries('main').some((entry) => entry.options.key === panel)
      layout.selectPanel(valid ? panel : null)
      previousPanel = valid ? panel : null
    } finally {
      transition = false
    }
  }
  function onPanel() {
    if (transition || disposed) return
    const panel = selected()
    if (panel === panelId) {
      if (view === 'bot') layout.selectPanel(null)
      else if (view !== 'management') enter('bot')
    } else if ((view === 'bot' && panel) || view === 'management') {
      if (viewAt(browser.location.hash)) removeRoute()
      leave(panel, Boolean(panel))
    } else if (!view) previousPanel = panel
  }
  function onLocation() {
    if (disposed) return
    const next = viewAt(browser.location.hash)
    if (next) {
      if (!view) previous = browser.history.state?.[historyKey] ?? place(false)
      const settings = browser.location.hash === providerSettingsHash
      if (settings || browser.location.hash === legacyAgentsHash || !browser.history.state?.[historyKey]) saveRoute(next, false)
      show(next, settings ? { settings: 'local-agents' } : undefined)
    } else if (view) leave(previous?.panel, true)
  }
  const unsubscribe = layout.panelInfo.subscribe(onPanel)
  browser.addEventListener('popstate', onLocation)
  browser.addEventListener('hashchange', onLocation)
  onLocation()
  onPanel()
  browser.dispatchEvent?.(new Event('godbot-router-ready'))
  return {
    openBot: (target) => enter('bot', target),
    openManagement: () => enter('management'),
    back() {
      if (!view) return
      if (previous?.pushed && browser.history.length > 1) browser.history.back()
      else {
        removeRoute()
        leave(previous?.panel, true)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      browser.removeEventListener('popstate', onLocation)
      browser.removeEventListener('hashchange', onLocation)
      browser.document?.documentElement.removeAttribute('data-godbot-workspace')
      unmount?.()
      unmount = undefined
      view = null
    },
  }
}

/** The workbench portals its navigation into this native DSH seat. Both columns share a single React tree. */
export function sidebarOutlet() {
  let current = null
  const listeners = new Set()
  return {
    getSidebar: () => current,
    subscribeSidebar(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(value) {
      if (
        current?.node === value?.node &&
        current?.collapsed === value?.collapsed &&
        current?.drawer === value?.drawer
      )
        return
      current = value
      for (const listener of listeners) listener()
    },
  }
}
