// Modified for Godbot. See THIRD_PARTY_NOTICES.
import { createElement as h, useState } from 'react'
import { t } from './i18n.js'

export function AgentForm({ initial, submit, close }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [args, setArgs] = useState((initial?.args ?? []).join(' '))
  const [error, setError] = useState('')
  const save = () => {
    const payload = { name, command, args: args.split(/\s+/).filter(Boolean) }
    submit(payload).then(() => close()).catch(failure => setError(failure?.message ?? String(failure)))
  }
  return h('div', { className: 'bt-set-form' },
    h('label', { className: 'bt-set-field' }, h('span', null, t('Name')), h('input', { className: 'bt-input', value: name, autoFocus: true, onChange: event => setName(event.target.value) })),
    h('div', { className: 'bt-set-form-row' },
      h('label', { className: 'bt-set-field' }, h('span', null, t('Command')), h('input', { className: 'bt-input bt-la-code-input', value: command, placeholder: 'my-agent', spellCheck: false, onChange: event => setCommand(event.target.value) })),
      h('label', { className: 'bt-set-field' }, h('span', null, t('Arguments')), h('input', { className: 'bt-input bt-la-code-input', value: args, placeholder: 'acp', spellCheck: false, onChange: event => setArgs(event.target.value) }))),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-set-actions bt-set-form-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: close }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: save }, t('Save'))))
}
