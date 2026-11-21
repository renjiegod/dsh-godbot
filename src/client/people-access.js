import { createElement as h, useState } from 'react'
import { button, field } from './controls.js'

const roleLabels = { none:'未共享', view:'查看', chat:'聊天和上传', manage:'管理与审批' }

export function PeopleAccess({ team, client }) {
  const [view, setView] = useState(null)
  const [invitation, setInvitation] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const call = (verb, fields = {}) => client.dispatch({ action:'automation.people.' + verb, teamId:team.id, ...fields })
  async function refresh() { setView(await call('list')) }
  async function submit(verb, body) {
    setPending(true); setError(''); setInvitation('')
    try {
      const result = await call(verb,body)
      if (result.url) setInvitation(result.url)
      await refresh()
    } catch (cause) { setError(cause.message) } finally { setPending(false) }
  }
  const permissions = person => h('form', { key:person.id + JSON.stringify(person.permissions), className:'gb-form', onSubmit:event => {
    event.preventDefault()
    const choices = [...new FormData(event.currentTarget)].filter(([,role]) => role !== 'none')
    void submit('permissions',{id:person.id, revision:person.revision ?? 0, permissions:Object.fromEntries(choices)})
  } }, h('h4',null,person.name), ...view.resources.map(resource =>
    field(resource.name + ' · ' + ({ native:'原生', bot:'Bot', room:'群' }[resource.kind]),
      h('select',{ name:resource.id, defaultValue:person.permissions[resource.id] || 'none' },
        ...Object.entries(roleLabels).map(([role,label]) => h('option',{key:role,value:role},label))))),
    h('button',{ type:'submit',disabled:pending },'保存权限'),
    button('生成新设备邀请',() => void submit('invite',{id:person.id}),{ disabled:pending }),
    button('撤销该用户',() => void submit('revoke',{id:person.id}),{ disabled:pending }))
  return h('details',{ className:'gb-card',onToggle:e => {
    if (e.currentTarget.open) void refresh().catch(cause => setError(cause.message))
    else setInvitation('')
  } },h('summary',null,'多人共享与审计'),
  h('p',null,'按人选择可见会话。共享后，该会话已有的消息、任务证据和附件也可读取。'),
  error && h('p',{role:'alert',className:'gb-error'},error),
  h('form',{className:'gb-form',onSubmit:e => {
    e.preventDefault()
    const name = new FormData(e.currentTarget).get('name')
    void submit('invite',{name})
  } },field('用户名称',h('input',{name:'name',required:true,maxLength:100})),
  h('button',{type:'submit',disabled:pending},'创建个人邀请')),
  invitation && h('div',{role:'status','data-sensitive':true},h('p',null,'个人邀请可用一次，15 分钟内有效。'),h('code',null,invitation)),
  ...(view?.people ?? []).filter(person => !person.revoked).map(permissions),
  !!view?.audit.length && h('details',null,h('summary',null,'操作记录'),
  h('ul',null,...view.audit.map(entry => h('li',{key:entry.id},entry.createdAt + ' · ' +
    (view.people.find(p => p.id === entry.actor)?.name ?? entry.actor) + ' · ' + entry.action +
    (entry.resource ? ' · ' + entry.resource : ''))))))
}
