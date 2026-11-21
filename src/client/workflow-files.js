import { createElement as h, useEffect, useRef, useState } from 'react'
import { mapWorkflow, readWorkflowFile, workflowFile } from '../team/workflow-file.js'
import { button, field, option, row } from './controls.js'

function download(flow, bots) {
  const file = workflowFile(flow, bots)
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'godbot-workflow.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function WorkflowFiles({ teamId, bots, workflow, client, onImported }) {
  const [preview, setPreview] = useState(null)
  const [index, setIndex] = useState(0)
  const [mapping, setMapping] = useState(new Map())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sequence = useRef(0)
  const sending = useRef(false)
  const lastRequest = useRef(null)
  useEffect(() => () => { sequence.current++ }, [teamId])
  const selected = preview?.workflows[index]
  const used = new Set(selected?.nodes.map(node => node.ownerId))
  const required = preview?.bots.filter(bot => used.has(bot.ref)) ?? []
  async function open(file) {
    const seq = ++sequence.current
    setError('')
    setPreview(null)
    if (!file) return
    try {
      if (file.size > 4_000_000) throw new Error('模板文件超过 4 MB。')
      const parsed = readWorkflowFile(await file.text())
      if (seq !== sequence.current) return
      setPreview(parsed)
      setIndex(0)
      setMapping(new Map(parsed.bots.map(bot => [bot.ref, bots.find(m => m.name === bot.name)?.id ?? ''])))
      lastRequest.current = null
    } catch (cause) { if (seq === sequence.current) setError(cause.message) }
  }
  async function save() {
    if (sending.current) return
    const seq = sequence.current
    sending.current = true
    setBusy(true)
    setError('')
    try {
      const definition = mapWorkflow(selected, mapping)
      const key = JSON.stringify([teamId, definition])
      if (lastRequest.current?.key !== key) lastRequest.current = { key, id: crypto.randomUUID() }
      const saved = await client.dispatch({ action: 'workflow.save', teamId, ...definition, requestId: lastRequest.current.id })
      if (seq !== sequence.current) return
      await onImported(saved)
      if (seq === sequence.current) setPreview(null)
    } catch (cause) { if (seq === sequence.current) setError(cause.message) }
    finally {
      sending.current = false
      if (seq === sequence.current) setBusy(false)
    }
  }
  return h('div', { className: 'gb-stack' },
    row(workflow && button('导出工作流模板', () => {
      try { download(workflow, bots); setError('') } catch (cause) { setError(cause.message) }
    }), h('label', { className: 'gb-workflow-file' }, '导入工作流模板', h('input', {
      type: 'file', accept: '.json,application/json', disabled: busy,
      onChange: event => { const file = event.target.files[0]; event.target.value = ''; void open(file) },
    }))),
    selected && h('section', { className: 'gb-card gb-form', 'aria-label': '工作流模板预览' },
      h('h3', null, '导入工作流'),
      preview.workflows.length > 1
        ? field('选择模板中的工作流', h('select', { value: index, disabled: busy, onChange: e => setIndex(Number(e.target.value)) },
          preview.workflows.map((flow, i) => option(String(i), flow.name))))
        : h('strong', null, selected.name),
      h('p', null, selected.nodes.length + ' 个节点 · ' + selected.edges.length + ' 条连线'),
      required.map(bot => h('label', { key: bot.ref, className: 'gb-field' }, h('span', null, bot.name + ' 对应的 Bot'),
        h('select', { value: mapping.get(bot.ref) ?? '', disabled: busy, onChange: e => {
          const id = e.target.value
          setMapping(previous => new Map(previous).set(bot.ref, id))
        } }, option('', '选择负责 Bot'), bots.map(member => option(member.id, member.name))))),
      row(button('保存导入的工作流', save, { className: 'gb-primary', disabled: busy || required.some(bot => !mapping.get(bot.ref)) }),
        button('取消导入', () => { setPreview(null); setError('') }, { disabled: busy }))),
    error && h('p', { role: 'alert', className: 'gb-error' }, error))
}
