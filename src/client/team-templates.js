import { createElement as h, useState } from 'react'

export function TeamTemplates({ client, rooms }) {
  const [roomId, setRoom] = useState('')
  const [draft, setDraft] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [plans, setPlans] = useState([])
  const call = (name, fields) => client.dispatch({ action: 'team-workspace.template' + name, ...fields })
  const perform = async fn => {
    setBusy(true); setFeedback(''); setError('')
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function download() {
    const data = await call('Export', { roomId })
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'godbot-team.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function open(file) {
    setDraft(null)
    if (!file) return
    if (file.size > 4_000_000) throw new Error('模板文件超过 4 MB。')
    const data = await call('Preview', { template: await file.text() })
    setDraft({ data, id: crypto.randomUUID() })
  }
  async function install() {
    const imported = await call('Import', { template: draft.data, requestId: draft.id })
    setFeedback(['已创建 ' + Object.keys(imported.mapping).length + ' 个 Bot 或群组',
      imported.workflows?.length && '已保存 ' + imported.workflows.length + ' 个工作流',
      imported.plans.length && '导入的计划已暂停'].filter(Boolean).join('。') + '。')
    setDraft(null)
    setPlans(await call('Plans'))
  }
  return h('details', { className: 'gb-inbox-section', onToggle: e => { if (e.currentTarget.open) void perform(async () => setPlans(await call('Plans'))) } },
    h('summary', null, '团队模板'),
    h('div', { className: 'gb-inbox-section-body' },
      h('div', { className: 'gb-modal-actions gb-template-export' },
        h('label', { className: 'gb-field' }, h('span', null, '导出范围'),
          h('select', { value: roomId, onChange: e => setRoom(e.target.value) },
            h('option', { value: '' }, '所有公开成员和群'), rooms.map(r => h('option', { key: r.id, value: r.id }, r.name)))),
        h('button', { type: 'button', disabled: busy, onClick: () => perform(download) }, '导出模板')),
      h('label', { className: 'gb-field' }, h('span', null, '导入团队模板'),
        h('input', { type: 'file', accept: '.json', disabled: busy,
          onChange: e => { const file = e.target.files[0]; e.target.value = ''; void perform(() => open(file)) } })),
      draft && h('section', { className: 'gb-template-preview', 'aria-label': '团队模板预览' },
        h('p', null, '新成员 · ' + draft.data.bots.map(b => b.name).join('、')),
        h('p', null, '群组 · ' + (draft.data.rooms.map(r => r.name).join('、') || '无')),
        draft.data.bots.filter(b => b.skills.length).map(b => h('p', { key: b.ref }, b.name + ' 的技能清单 · ' + b.skills.join('、'))),
        draft.data.plans.map((p, i) => h('p', { key: i }, '暂停计划 · ' + p.title)),
        draft.data.workflows?.map((flow, i) => h('p', { key: 'flow-' + i },
          '工作流 · ' + flow.name + '（' + flow.nodes.length + ' 个节点）')),
        h('button', { type: 'button', className: 'gb-modal-primary', disabled: busy, onClick: () => perform(install) }, '确认导入模板')),
      plans.map(p => h('div', { key: p.id, className: 'gb-modal-actions gb-template-plan' },
        h('span', null, p.title + ' · ' + ({ paused: '已暂停', enabling: '待核对', enabled: '已启用' }[p.status] ?? p.status)),
        p.status === 'paused' && h('button', { type: 'button', disabled: busy, onClick: () => perform(async () => {
          await call('Enable', { id: p.id }); setPlans(await call('Plans'))
        }) }, '启用计划'))),
      feedback && h('p', { className: 'gb-modal-note', role: 'status' }, feedback),
      error && h('p', { className: 'gb-modal-note', role: 'alert' }, error)))
}
