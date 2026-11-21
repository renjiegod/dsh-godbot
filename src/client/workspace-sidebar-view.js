import { createElement as h } from 'react'
import { button } from './controls.js'
import { Icon, iconButton } from './chat-ui.js'
import { webIconUrl } from '../host/web-icon.js'
import { WorkspaceSwitch } from './workspace-switch.js'

export function WorkspaceSidebar({ client, sidebar, navigation, page, go, openSettings }) {
  const rail = sidebar.collapsed && !sidebar.drawer
  function item(label, icon, onClick, active) {
    return button(h('span', { className: 'gb-row' }, h(Icon, { name: icon }), !rail && label), onClick, {
      className: 'gb-navrow', title: label, 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    })
  }
  return h('aside', { className: 'gb-side' + (rail ? ' gb-side-rail' : ''), 'aria-label': 'Godbot 导航' },
    h('div', { className: rail ? 'gb-rail-top' : 'gb-side-top' },
      !rail && h('span', { className: 'gb-brand' }, h('img', { src: webIconUrl, alt: '', width: 26, height: 26 }), 'Godbot'),
      iconButton(rail ? '展开侧栏' : '收起侧栏', 'panel', navigation.toggleSidebar, { className: 'gb-round' })),
    h(WorkspaceSwitch, { current: 'management', client, wide: !rail, onBot: () => navigation.openBot(), onBack: navigation.back }),
    h('nav', { className: 'gb-list', 'aria-label': '团队管理导航' },
      item('任务板', 'task', () => go('tasks'), page === 'tasks'),
      item('自动化任务', 'clock', () => go('routines'), page === 'routines'),
      item('Bot 设置', 'sliders', () => openSettings('bots')),
      item('群聊设置', 'chat', () => openSettings('groups')),
      item('会话定时消息', 'clock', () => openSettings('schedules'))))
}
