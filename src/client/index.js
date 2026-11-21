import { createElement as h, useLayoutEffect, useRef } from 'react'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { Workbench } from './workbench.js'
import controlsCss from './workspace-controls.css'
import modalCss from './modal.css'
import inboxCss from './workspace-inbox.css'
import runtimeCss from './workspace-runtime.css'
import { themeStyle } from './theme.js'
import { createClient } from './model.js'
import { mountTeamSurface } from './team-surface.js'
import { connectNavigation, panelId, sidebarOutlet } from './navigation.js'
import { webIconUrl } from '../host/web-icon.js'
import { installSidebarLoadingStyle } from '../host/web-index.js'
import { installStyles } from './team-ui/styles.js'

export const inject = ['slots', 'layout', 'connection', 'sessions', 'uiWorkspace']

function icon({ size = 18 }) {
  return h('img', {
    src: webIconUrl,
    alt: '',
    width: size,
    height: size,
    style: { display: 'block', borderRadius: '24%' },
  })
}

export function apply(ctx) {
  ctx.effect(() => installSidebarLoadingStyle(document), 'Godbot sidebar loading style')
  ctx.effect(() => {
    const style = installStyles(themeStyle + controlsCss + modalCss + inboxCss + runtimeCss, 'workspace-controls')
    return () => style.remove()
  }, 'Godbot controls and dialogs')
  const client = createClient(ctx.connection)
  const outlet = sidebarOutlet()
  let router
  const navigation = {
    ...outlet,
    back: () => router?.back(),
    openBot: (target) => router?.openBot(target),
    openManagement: () => router?.openManagement(),
    toggleSidebar: () => ctx.layout.toggleSidebar(),
  }
  function SidebarSeat({ collapsed, drawer }) {
    const ref = useRef(null)
    useModalLayer(ref, drawer && !collapsed, navigation.toggleSidebar)
    useLayoutEffect(() => {
      outlet.publish({ node: ref.current, collapsed, drawer })
      return () => outlet.publish(null)
    }, [collapsed, drawer])
    return h('div', {
      ref,
      className: 'gb-root gb-sidebar-shell',
      'data-godbot-sidebar': '',
      'data-collapsed': collapsed || undefined,
      'data-drawer': drawer || undefined,
      role: drawer ? 'dialog' : undefined,
      'aria-label': drawer ? 'Godbot 导航' : undefined,
      'aria-modal': (drawer && !collapsed) || undefined,
      'data-shortcut-modal': drawer && !collapsed ? 'sidebar' : undefined,
      tabIndex: drawer ? -1 : undefined,
    })
  }

  // Shadow only the two native navigation seats while this tab is displaying Godbot.
  function replaceSeat(name, component) {
    return ctx.slots.inject(name, () => {
      const priorities = ctx.slots.entries(name).map((entry) => entry.options.priority ?? 0)
      return ctx.slots.register({ name, priority: Math.min(0, ...priorities) - 1 }, component)
    })
  }

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: panelId, label: 'Godbot', order: 11 }, icon),
  )
  ctx.slots.inject('main', () => {
    const unregister = ctx.slots.register({ name: 'main', key: panelId }, () =>
      h(Workbench, { client, navigation }),
    )
    router = connectNavigation(
      ctx,
      window,
      () => {
        const removeSidebar = replaceSeat('sidebar', SidebarSeat)
        const removeLeading = replaceSeat('shell.leading', () => null)
        return () => {
          removeLeading()
          removeSidebar()
        }
      },
      (target) => mountTeamSurface(ctx, client, navigation, target),
    )
    return () => {
      router.dispose()
      unregister()
    }
  })
}
