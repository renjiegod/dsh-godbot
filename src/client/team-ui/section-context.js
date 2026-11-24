import { createElement as h, useEffect, useState } from 'react'
import { GodbotModal } from '../modal.js'
import { t } from './i18n.js'

export function SectionContext({ section, actions, readOnly, memoryEnabled }) {
  const [description, setDescription] = useState(section.description ?? '')
  const [view, setView] = useState(null)
  const [editor, setEditor] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = () => { if (!busy) actions.closeSectionContext() }
  useEffect(() => {
    if (!memoryEnabled) return undefined
    let current = true
    actions.sectionMemory('memory-view', section.id).then(
      result => { if (current) setView(result) },
      failure => { if (current) setError(failure?.message ?? String(failure)) },
    )
    return () => { current = false }
  }, [actions, section.id, memoryEnabled])

  const perform = async (call, done) => {
    setBusy(true)
    setError('')
    try { done(await call()) } catch (failure) { setError(failure?.message ?? String(failure)) }
    finally { setBusy(false) }
  }
  const memory = (method, body) => perform(() => actions.sectionMemory(method, section.id, body), result => {
    setView(result)
    setEditor(null)
    setRemoving(null)
  })
  const add = () => setEditor({ text: '', topic: '' })
  const save = event => {
    event.preventDefault()
    if (busy || !editor?.text.trim()) return
    const text = editor.text.trim()
    return editor.entry
      ? memory('memory-edit', { text: editor.entry.text, topic: editor.entry.topic, next: text })
      : memory('memory-add', { text, topic: editor.topic.trim() || null })
  }
  return h(GodbotModal, { title: t('Section context for {name}', { name: section.name }), close, closeLabel: t('Close') },
    h('div', { className: 'gb-section-context', 'data-godbot-section-context': section.id },
      h('label', { className: 'gb-section-field' }, t('Section description'),
        h('textarea', { className: 'bt-input bt-input-area', rows: 4, maxLength: 4000, value: description,
          readOnly: readOnly || busy, onChange: event => setDescription(event.target.value) })),
      h('p', { className: 'bt-set-hint' }, t('The section description and memory are available to every Bot in this section.')),
      !readOnly ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || description.trim() === (section.description ?? ''),
        onClick: () => void perform(() => actions.saveSection({ id: section.id, description }), saved => setDescription(saved.description ?? '')) }, t('Save description')) : null,
      h('h3', null, t('Shared section memory')),
      !memoryEnabled ? h('p', null, t('Memory is turned off on this host')) : null,
      memoryEnabled && view === null && !error ? h('p', { role: 'status' }, t('Loading…')) : null,
      view?.entries.length === 0 ? h('p', null, t('Nothing saved yet')) : null,
      view?.entries.length ? h('ul', { className: 'gb-section-entries' }, view.entries.map((entry, index) => h('li', { key: entry.id || index },
        h('div', null, entry.topic ? h('small', null, entry.topic) : null, h('div', null, entry.text)),
        !readOnly && h('div', { className: 'gb-section-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
            onClick: () => { setRemoving(null); setEditor({ entry, text: entry.text, topic: entry.topic ?? '' }) } }, t('Edit')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => removing === index
            ? void memory('memory-forget', { text: entry.text, topic: entry.topic }) : setRemoving(index) },
          t(removing === index ? 'Confirm removal' : 'Remove')))))) : null,
      view && !readOnly && !editor ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: add }, t('Add')) : null,
      editor ? h('form', { className: 'gb-section-editor', onSubmit: save },
        !editor.entry && h('label', { className: 'gb-section-field' }, t('Memory topic'),
          h('input', { className: 'bt-input', value: editor.topic, disabled: busy, onChange: event => setEditor({ ...editor, topic: event.target.value }) })),
        h('label', { className: 'gb-section-field' }, t('Memory entry'),
          h('textarea', { className: 'bt-input bt-input-area', rows: 3, autoFocus: true, maxLength: view?.limits?.entry,
            disabled: busy, value: editor.text, onChange: event => setEditor({ ...editor, text: event.target.value }) })),
        h('div', { className: 'gb-section-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setEditor(null) }, t('Cancel')),
          h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy || !editor.text.trim() }, t('Save')))) : null,
      error ? h('p', { className: 'gb-failover-error', role: 'alert' }, error) : null))
}

export const SECTION_CONTEXT_CSS = `
.gb-section-context{display:grid;gap:10px;color:var(--bt-ink)}
.gb-section-context h3,.gb-section-context p{margin:0}
.gb-section-context button{justify-self:start}
.gb-section-field,.gb-section-editor{display:grid;gap:6px;min-width:0}
.gb-section-field textarea{width:100%;box-sizing:border-box;resize:vertical}
.gb-section-entries{padding:0;margin:0;list-style:none}
.gb-section-entries li{display:grid;gap:6px;border-bottom:1px solid var(--bt-line-2);padding:8px 0;overflow-wrap:anywhere}
.gb-section-entries small{color:var(--bt-ink-3)}
.gb-section-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
`
