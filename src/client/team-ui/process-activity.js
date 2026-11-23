import { createElement as h } from 'react'
import { ChatsIcon, DiffIcon, GlobeIcon, MemoryIcon, QueueIcon, SearchIcon, TerminalIcon } from './icons.js'
import { Icon } from '../chat-ui.js'
import { t } from './i18n.js'

const activities = {
  command: ['Run command', TerminalIcon],
  code: ['Run code', TerminalIcon],
  read: ['Read files', DiffIcon],
  search: ['Search files', SearchIcon],
  edit: ['Edit files', DiffIcon],
  skill: ['Load skill', MemoryIcon],
  webSearch: ['Search the web', GlobeIcon],
  webFetch: ['Read a web page', GlobeIcon],
  agent: ['Call an agent', ChatsIcon],
  plan: ['Update plan', QueueIcon],
  image: ['Generate image', () => h(Icon, { name: 'sparkle', size: 16 })],
  context: ['Context injection', DiffIcon],
  thinking: ['Thought', () => h(Icon, { name: 'sparkle', size: 16 })],
}

export function processLabel(kind) {
  return t(Object.hasOwn(activities, kind) ? activities[kind][0] : 'Tool call')
}

export function ProcessIcon({ kind }) {
  const glyph = Object.hasOwn(activities, kind) ? activities[kind][1] : QueueIcon
  return h(glyph)
}

export function revealConversationProcess() {
  const body = document.body
  const selector = '[data-conversation-scroll] [data-step-process-body][hidden="until-found"]'
  let frame = 0
  const schedule = () => {
    if (frame || !body.hasAttribute('data-gb-conversation')) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!body.hasAttribute('data-gb-conversation')) return
      // DSH handles beforematch by opening the actual disclosure. CSS alone
      // leaves visible tool rows inside an accessibility-hidden subtree.
      for (const group of body.querySelectorAll(selector)) group.dispatchEvent(new Event('beforematch'))
    })
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => (record.type === 'attributes'
      ? record.target === body || record.target.matches(selector)
      : [...record.addedNodes].some(node => node instanceof Element &&
        (node.matches(selector) || node.querySelector(selector)))))) schedule()
  })
  observer.observe(body, { subtree: true, childList: true, attributeFilter: ['hidden', 'data-gb-conversation'] })
  schedule()
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  }
}
