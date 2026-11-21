import { createElement as h } from 'react'
import { Icon } from './chat-ui.js'
import { WorkspaceInbox } from './workspace-inbox.js'
import actionsStyle from './workspace-actions.css'

export function WorkspaceActions({ wide, onBack, client }) {
  return h('nav', {
    className: 'gb-workspace-actions',
    'aria-label': 'Godbot 工作区',
    'data-rail': !wide || undefined,
  },
    h('style', null, actionsStyle),
    h(WorkspaceInbox, { client }),
    h('button', {
      type: 'button', className: 'gb-workspace-action', title: '返回 dsh', 'aria-label': '返回 dsh', onClick: onBack,
    }, h(Icon, { name: 'back', size: 16 })))
}
