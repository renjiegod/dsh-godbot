const byId = id => document.getElementById(id)
const status = text => { byId('status').textContent = text }
const element = (tag, text) => {
  const node = document.createElement(tag)
  if (text != null) node.textContent = text
  return node
}
const anchor = (label, href) => {
  const node = element('a', label)
  node.href = href
  return node
}
const access = { view: '查看', chat: '聊天', manage: '管理' }
let resources = []
let events
let generation = 0
let previous = ''
let searchVersion = 0

async function api(path, body) {
  const response = await fetch('/share/api/' + path, body === undefined ? { cache: 'no-store' } : {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '请求失败')
  return result
}

function replaceAccess(items) {
  const changed = JSON.stringify(resources) !== JSON.stringify(items)
  resources = items
  if (changed) {
    searchVersion++
    byId('results').replaceChildren()
    byId('resources').replaceChildren(...items.map(resource => {
      const li = element('li')
      li.append(anchor(resource.name + ' · ' + access[resource.role], '#resource=' + encodeURIComponent(resource.id)))
      return li
    }))
  }
}

const currentKey = () => new URLSearchParams(location.hash.slice(1)).get('resource')
const actionButton = (label, fn) => {
  const button = element('button',label)
  button.type = 'button'
  button.onclick = async () => {
    button.disabled = true
    try { await fn(); status(''); await refresh() } catch (error) { status(error.message) } finally { button.disabled = false }
  }
  return button
}
function composer(path) {
  const section = element('section')
  section.dataset.composer = path
  const box = element('textarea')
  box.setAttribute('aria-label','消息')
  const send = actionButton('发送',async () => {
    if (!box.value.trim()) return
    await api(path + '/chat',{ text:box.value,requestId:crypto.randomUUID() })
    box.value = ''
  })
  const file = element('input')
  file.type = 'file'
  file.setAttribute('aria-label','选择附件')
  section.append(file, actionButton('上传附件',async () => {
    const selected = file.files?.[0]
    if (!selected) throw new Error('请选择文件')
    if (selected.size > 2*1024*1024) throw new Error('附件超过 2 MiB')
    const reader = new FileReader()
    const encoded = await new Promise((resolve,reject) => {
      reader.onload = () => resolve(reader.result.split(',')[1])
      reader.onerror = reject
      reader.readAsDataURL(selected)
    })
    await api(path + '/files',{name:selected.name,data:encoded})
  }))
  section.prepend(box,send)
  return section
}

function messageView(data, path, existingComposer) {
  const title = element('h1',data.name)
  const messages = element('section')
  for (const msg of data.messages) messages.append(element('article',(msg.kind === 'user' ? '消息　' : '') + msg.text))
  const tasks = element('section')
  for (const task of data.tasks) {
    tasks.append(element('h3',task.title),element('article',task.status + '\n' + (task.evidence || task.criteria || '')))
    if (data.role === 'manage' && task.status === 'reported') {
      const reason = element('input')
      reason.setAttribute('aria-label','退回原因')
      const review = approve => api(path + '/review', { id:task.id, revision:task.revision, evidenceRevision:task.evidenceRevision,
        approve, reason:reason.value })
      tasks.append(actionButton('验收通过',() => review(true)),reason,actionButton('退回任务',() => review(false)))
    }
  }
  const pending = element('section')
  for (const request of data.approvals) {
    const item = element('article',request.text || request.tool)
    if (data.role === 'manage') for (const [choice,label] of [['allow','允许'],['reject','拒绝']]) {
      item.append(actionButton(label, () => api(path + '/approve',{id:request.id,choice})))
    }
    pending.append(item)
  }
  const files = element('section')
  for (const item of data.files) {
    const row = element('div')
    row.append(anchor(item.name, '/share/api/' + path + '/files/' + encodeURIComponent(item.id)))
    files.append(row)
  }
  const exportLink = anchor('导出会话证据','/share/api/' + path + '/export')
  exportLink.download = 'godbot-export.json'
  const parts = [title,messages,tasks,pending,files,exportLink]
  if (data.role !== 'view') parts.push(existingComposer ?? composer(path))
  return parts
}

async function refresh() {
  const key = currentKey()
  for (const link of byId('resources').querySelectorAll('a')) {
    if (key && link.hash === '#resource=' + encodeURIComponent(key)) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  const ticket = ++generation
  const root = byId('work')
  if (!key || !resources.some(r => r.id === key)) {
    previous = ''
    const title = element('h1',key ? '此资源不可用' : '共享工作区')
    const hint = resources.length ? '选择一个已授权的资源，查看会话和任务。' : '当前账号还没有获授权的资源。'
    root.replaceChildren(title, element('p',hint))
    return
  }
  try {
    const path = 'resources/' + encodeURIComponent(key)
    const data = await api(path)
    const fingerprint = JSON.stringify(data)
    if (ticket !== generation || fingerprint === previous) return
    const editor = root.dataset.key === key ? root.querySelector('[data-composer]') : null
    root.dataset.key = key
    previous = fingerprint
    root.replaceChildren(...messageView(data,path,editor))
  } catch (error) {
    if (ticket === generation) { previous = ''; root.replaceChildren(element('h1',error.message)) }
  }
}

async function join() {
  const invitation = new URLSearchParams(location.hash.slice(1)).get('invite')
  if (invitation) {
    history.replaceState(null,'',location.pathname)
    await api('join',{invite:invitation})
  }
  const signIn = await api('sign-in').catch(() => ({}))
  byId('single-sign-on').hidden = signIn.sso !== true
  const person = await api('me')
  byId('single-sign-on').hidden = true
  byId('person').textContent = person.name
  replaceAccess(person.resources)
  await refresh()
  events = new EventSource('/share/api/events')
  events.addEventListener('refresh',async event => {
    replaceAccess(JSON.parse(event.data).resources)
    await refresh()
  })
  events.addEventListener('revoked',() => {
    events.close()
    replaceAccess([])
    void refresh()
    status('当前身份授权已撤销')
  })
}
window.addEventListener('hashchange',refresh)
byId('search').onsubmit = async e => {
  e.preventDefault()
  const ticket = ++searchVersion
  try {
    const matches = await api('search?q=' + encodeURIComponent(new FormData(e.target).get('q')))
    if (ticket !== searchVersion) return
    byId('results').replaceChildren(...matches.map(hit => {
      const row = element('div')
      row.append(anchor(hit.text,'#resource=' + encodeURIComponent(hit.resource)))
      return row
    }))
  } catch(error) { status(error.message) }
}
join().catch(error => status(error.message))
