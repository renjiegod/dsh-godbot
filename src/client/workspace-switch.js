import { createElement as h } from 'react'
import { Icon } from './chat-ui.js'
import { WorkspaceInbox } from './workspace-inbox.js'
import { switchStyle } from './workspace-switch-style.js'

export const workspaces = [
  { key: 'bot', label: 'Bot 团队', short: 'Bot', icon: 'chat' },
  { key: 'management', label: '团队管理', short: '管理', icon: 'task' },
]

/** The two Godbot workspaces as one segmented control, plus the way back to dsh. */
export function WorkspaceSwitch({ current, wide = true, onBot, onManagement, onBack, client }) {
  const actions = { bot: onBot, management: onManagement }
  return h(
    'nav',
    {
      className: 'gb-switch',
      'aria-label': 'Godbot 工作区',
      'data-godbot': 'workspace-switch',
      'data-rail': !wide || undefined,
    },
    h('style', null, switchStyle),
    h(
      'div',
      { className: 'gb-switch-seg' },
      workspaces.map(({ key, label, short, icon }) =>
        h(
          'button',
          {
            key,
            type: 'button',
            title: label,
            'aria-label': label,
            'aria-current': current === key ? 'page' : undefined,
            'data-workspace': key,
            onClick: current === key ? undefined : actions[key],
          },
          h(Icon, { name: icon, size: 15 }),
          wide && h('span', { className: 'gb-switch-long' }, label),
          wide && h('span', { className: 'gb-switch-short', 'aria-hidden': true }, short),
        ),
      ),
    ),
    client && h(WorkspaceInbox, { client }),
    h(
      'button',
      { type: 'button', className: 'gb-switch-back', title: '返回 dsh', 'aria-label': '返回 dsh', onClick: onBack },
      h(Icon, { name: 'back', size: 16 }),
    ),
  )
}
