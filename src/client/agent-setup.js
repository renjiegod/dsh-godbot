import { createElement as h, useState } from 'react'
import { displayCli } from './provider-agents-model.js'

// Discovery only inspects available CLIs. Changing the route is an explicit action.
export function AgentSetup({ bot, roster, actions, useLocalAgents, runModeNotes, avatarAfter, AgentLogo }) {
  const { agents, known, scanning } = useLocalAgents(true,actions)
  const [choice, setChoice] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  if (!known)
    return h('p', { className: 'bt-model-choice-provider', role: 'status' }, '正在检查本机 Agent CLI…')
  const detected = agents.filter((agent) =>
    ['claude-code', 'codex-cli', 'antigravity'].includes(displayCli(agent.route)),
  )
  if (!detected.length) return null
  const agent = detected.find((item) => item.route === choice)
  const resolveModel = (route) =>
    (roster.models ?? []).find((model) => model.ref === route + '/default')?.name || 'CLI 默认模型'
  const target = choice + '/default'
  async function apply() {
    if (!agent || agent.disabled || scanning || busy) return
    setBusy(true)
    setError('')
    try {
      await actions.godbot.changeProvider(bot, agent, target, actions, avatarAfter)
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy(false)
    }
  }
  return h(
    'section',
    { className: 'bt-model-chips', 'aria-label': '使用本机 Agent' },
    h(
      'div',
      { className: 'bt-model-choice-group' },
      h('div', { className: 'bt-model-choice-provider' }, '使用本机 Agent'),
      h(
        'div',
        { className: 'bt-model-choice-chips' },
        detected.map((item) =>
          h(
            'button',
            {
              key: item.route,
              type: 'button',
              className: 'bt-model-chip',
              disabled: busy || scanning || item.disabled,
              title: item.reason || item.accountLabel,
              'aria-pressed': choice === item.route,
              onClick: () => {
                setChoice(item.route)
                setError('')
              },
            },
            h(AgentLogo, { route: item.route, name: item.name, size: 18 }),
            item.name,
            ' · ',
            item.reason || item.accountLabel || resolveModel(item.route),
            item.signedIn === false ? ' · 未登录' : null,
          ),
        ),
      ),
      agent &&
        h(
          'div',
          { className: 'bt-runmode-confirm' },
          h(
            'ul',
            { className: 'bt-runmode-notes' },
            runModeNotes({ bot, roster, target, agent }).map((note) => h('li', { key: note }, note)),
          ),
          h(
            'button',
            { type: 'button', className: 'bt-send', disabled: busy, onClick: apply },
            busy ? '正在保存…' : '使用 ' + agent.name,
          ),
        ),
      error && h('p', { role: 'alert', className: 'bt-model-error' }, error),
    ),
  )
}
