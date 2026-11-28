import { createElement as h, useState } from 'react'
import { call } from './team-ui/api.js'
import { dateLocale, t } from './team-ui/i18n.js'
import { commentRunLabels } from '../team/work-board-discussion-format.js'
import { useBoardRead } from '../host/team-runtime/shared/work-board.js'

const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label)
const heading = label => h('h3', null, t(label))
const stamp = value => value ? new Date(value).toLocaleString(dateLocale()) : ''
const runStatus = run => t(commentRunLabels[run.status] ?? run.status)

export async function downloadBoardFile(id, fileId, commentId, snapshot = false) {
  const data = await call('board-comment-file', { id, fileId, commentId, snapshot })
  const bytes = Uint8Array.from(atob(data.bytes), c => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.download = data.name
  link.href = url
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function PlanningDetails({ item, pick, seed, openComment, annotate, readOnly }) {
  const [error, setError] = useState('')
  const plan = item.planning
  if (!plan) return null
  const fields = item.fields
  const links = (title, refs) => refs.length ? h('section', { className: 'wb-related' }, heading(title),
    ...refs.map(ref => button(ref.id + ' · ' + ref.title + (ref.stage ? ' · ' + t('Stage') + ' ' + ref.stage : ''),
      () => pick(ref.id), { key: ref.id, className: 'wb-btn wb-btn-soft' }))) : null
  async function snapshotFile(file) {
    try { await downloadBoardFile(item.id, file.id, undefined, true) }
    catch (cause) { setError(cause.message) }
  }
  function selectQuote(e) {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !e.currentTarget.contains(selection.anchorNode)
      || !e.currentTarget.contains(selection.focusNode)) return
    const range = selection.getRangeAt(0)
    const prefix = range.cloneRange()
    prefix.selectNodeContents(e.currentTarget)
    prefix.setEnd(range.startContainer, range.startOffset)
    const start = prefix.toString().length
    const length = range.toString().length
    if (length > 0 && length <= 4000) annotate({ start, end: start + length, quote: fields.description.slice(start, start + length) })
  }
  const hasRelations = plan.parent || plan.prerequisites.length || plan.dependents.length || plan.duplicateOf || plan.duplicates.length
  const pct = plan.progress.total ? Math.round((100 * plan.progress.completed) / plan.progress.total) : 0
  return h('div', { className: 'wb-planning-detail' },
    plan.waiting ? h('div', { className: 'wb-callout', role: 'status', 'data-tone': 'info' },
      t('Waiting for prerequisites') + ' · ' + plan.waiting) : null,
    item.reviewBlocked ? h('div', { className: 'wb-callout', role: 'status' },
      t('Evidence must match the current requirements and prerequisites. Request changes before accepting.')) : null,
    fields.description ? h('section', { className: 'wb-section-card' },
      h('div', { className: 'wb-section-head' },
        heading('Task description'),
        !readOnly ? button(t('Add description annotation'), () => annotate({ text: fields.description }), { className: 'wb-btn wb-btn-soft' }) : null),
      h('div', { className: 'wb-mono-block', onMouseUp: readOnly ? undefined : selectQuote }, fields.description)) : null,
    h('section', { className: 'wb-section-card' },
      h('div', { className: 'wb-section-head' },
        heading('Subtasks'),
        plan.progress.total ? h('span', { className: 'wb-tab-badge' }, plan.progress.completed + ' / ' + plan.progress.total) : null,
        !readOnly ? button(t('New subtask'), () => seed({ parent: item.id }), { className: 'wb-btn wb-btn-soft' }) : null),
      plan.progress.total ? h('div', { className: 'wb-progress-track' },
        h('div', { className: 'wb-progress-fill', style: { width: pct + '%' } })) : null,
      plan.children.length ? h('div', { className: 'wb-related' },
        ...plan.children.map(ref => button(ref.id + ' · ' + ref.title + (ref.stage ? ' · ' + t('Stage') + ' ' + ref.stage : ''),
          () => pick(ref.id), { key: ref.id, className: 'wb-btn' }))) : null),
    hasRelations ? h('section', { className: 'wb-section-card' },
      heading('Task relationships'),
      links('Parent work item', plan.parent ? [plan.parent] : []),
      links('Waits for', plan.prerequisites),
      links('Blocks', plan.dependents),
      links('Duplicate of', plan.duplicateOf ? [plan.duplicateOf] : []),
      links('Duplicates', plan.duplicates)) : null,
    plan.snapshot ? h('details', { className: 'wb-section-card' }, h('summary', null, t('Source discussion snapshot')),
      h('div', { className: 'wb-tools', style: { marginTop: '8px' } },
        button(plan.snapshot.id + ' · ' + t('Go to source comment'), () => openComment(plan.snapshot.id, plan.snapshot.commentId), { className: 'wb-btn' }),
        h('small', { className: 'wb-subtext' }, stamp(plan.snapshot.at))),
      h('strong', null, plan.snapshot.context.title),
      h('div', { className: 'wb-mono-block' }, plan.snapshot.context.description),
      ...plan.snapshot.context.comments.map((c, i) => h('blockquote', { key: i, className: 'wb-annotation' },
        h('strong', null, c.author), h('div', { className: 'wb-mono-block' }, c.text))),
      plan.snapshot.attachments.length ? h('div', { className: 'wb-tools' },
        ...plan.snapshot.attachments.map(file => button(file.name, () => void snapshotFile(file), { key: file.id, className: 'wb-btn' }))) : null) : null,
    plan.audit.length ? h('details', { className: 'wb-section-card' }, h('summary', null, t('Edit history')),
      ...plan.audit.map(entry => h('section', { key: entry.id, className: 'wb-activity-item' },
        h('small', { className: 'wb-subtext' }, stamp(entry.at), entry.reason ? ' · ' + entry.reason : ''),
        ...entry.changes.map(change => h('div', { key: change.field }, h('strong', null, t({
          description: 'Task description', title: 'Title', criteria: 'Acceptance criteria', priority: 'Priority',
          labels: 'Labels', startDate: 'Start date', dueDate: 'Due date', statusId: 'Task status',
          assignee: 'Owner', parent: 'Parent work item', stage: 'Stage', blockedBy: 'Waits for',
          duplicateOf: 'Duplicate of', customValues: 'Custom property', archived: 'Archived', pendingDispatch: 'Queued',
        }[change.field] ?? change.field)), h('div', { className: 'wb-mono-block' },
          String(typeof change.before === 'object' ? JSON.stringify(change.before) : change.before ?? '—') + '\n→ ' +
          String(typeof change.after === 'object' ? JSON.stringify(change.after) : change.after ?? '—'))))))) : null,
    error ? h('p', { className: 'gb-alert', role: 'alert' }, error) : null,
  )
}

export function BoardRunsPanel({ id, initialRun, subscribe, modify, readOnly, openExecution, openComment }) {
  const [runId, choose] = useState(initialRun ?? null)
  const [after, setAfter] = useState(null)
  const [before, setBefore] = useState(null)
  const [toolId, setTool] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const page = useBoardRead({ call, endpoint: 'board-runs', id, active: !runId, subscribe, query: { after } })
  const log = useBoardRead({ call, endpoint: 'board-runs', id, active: !!runId, subscribe, query: { runId, before } })
  const detail = useBoardRead({ call, endpoint: 'board-runs', id, active: !!toolId, query: { runId, toolId } })
  const error = page.error || log.error || detail.error
  const open = id => { choose(id); setBefore(null); setTool(null); setConfirm(null) }
  const run = log.data?.run
  const actions = run && !readOnly ? h('div', { className: 'wb-tools' },
    run.canStop ? button(t('Stop this run'), () => setConfirm('run-stop'), { className: 'wb-btn wb-btn-danger' }) : null,
    run.canRetry ? button(t('Retry this run'), () => setConfirm('run-retry'), { className: 'wb-btn' }) : null,
    confirm ? h('span', { className: 'wb-tools' },
      button(t('Confirm'), async () => {
        if (await modify({ op: confirm, runId: run.id, turnId: run.turnId })) {
          setConfirm(null)
          if (confirm === 'run-retry') open(null)
          else log.refresh()
        }
      }, { className: 'wb-primary' }), button(t('Cancel'), () => setConfirm(null), { className: 'wb-btn' })) : null) : null
  return h('section', { className: 'wb-run-panel' },
    error ? h('p', { className: 'gb-alert', role: 'alert' }, error) : null,
    runId ? h('div', { className: 'wb-run-panel' },
      h('div', { className: 'wb-tools' },
        button(t('All runs'), () => open(null), { className: 'wb-btn wb-btn-soft' }),
        run?.sessionId ? button(t('Open execution conversation'), () => openExecution(run), { className: 'wb-btn' }) : null,
        run?.commentId ? button(t('Go to source comment'), () => openComment(id, run.commentId), { className: 'wb-btn' }) : null),
      run ? h('div', { className: 'wb-section-card' },
        h('strong', null, run.name, ' · ', runStatus(run)),
        run.reason ? h('span', { className: 'wb-subtext' }, run.reason) : null,
        actions) : null,
      log.data?.unavailable ? h('p', { className: 'wb-subtext' }, t('Execution log becomes available when the engine reads this run.')) : null,
      before ? button(t('Latest events'), () => setBefore(null), { className: 'wb-btn' }) : null,
      log.data?.omitted ? button(t('Earlier activity'), () => setBefore(log.data.omitted), { className: 'wb-btn' }) : null,
      ...(log.data?.events ?? []).map((event, index) => h('div', { className: 'wb-run-event', key: index },
        event.type === 'tool'
          ? h('div', { className: 'wb-tools' }, h('strong', null, event.name), event.status ? t(event.status) : '',
              event.text, event.toolId ? button(t('Tool details'), () => setTool(toolId === event.toolId ? null : event.toolId), { className: 'wb-btn' }) : null)
          : h('div', { className: event.type === 'error' ? 'gb-alert wb-mono-block' : 'wb-mono-block', role: event.type === 'error' ? 'alert' : undefined }, event.text),
        event.toolId && event.toolId === toolId && detail.data ? Object.entries(detail.data)
          .filter(([key]) => key !== 'run').map(([key, value]) => h('div', { key }, h('strong', null, t(key)), h('div', { className: 'wb-mono-block' }, value))) : null)),
    ) : h('div', { className: 'wb-run-panel' },
      !page.data && !error ? h('p', { className: 'wb-subtext' }, t('Loading…')) : null,
      page.data && !page.data.runs.length ? h('p', { className: 'wb-subtext' }, t('No runs yet.')) : null,
      ...(page.data?.runs ?? []).map(run => h('div', { key: run.id, className: 'wb-run-event' },
        h('div', { className: 'wb-tools', style: { justifyContent: 'space-between' } },
          button((run.name ?? 'Bot') + ' · ' + runStatus(run) + (run.attempt ? ' · ' + t('Attempt {number}', { number: run.attempt }) : ''),
            () => open(run.id), { className: 'wb-btn wb-btn-soft' }),
          h('small', { className: 'wb-subtext' }, stamp(run.createdAt))),
        run.reason ? h('p', { className: 'wb-subtext', style: { margin: '6px 0 0' } }, run.reason) : null)),
      after ? button(t('Latest runs'), () => setAfter(null), { className: 'wb-btn' }) : null,
      page.data?.next ? button(t('Earlier runs'), () => setAfter(page.data.next), { className: 'wb-btn' }) : null,
    ))
}

export function BoardArtifactsPanel({ id, subscribe, openComment }) {
  const page = useBoardRead({ call, endpoint: 'board-artifacts', id, active: true, subscribe })
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  async function download(version, show) {
    try {
      setError('')
      if (!show) return await downloadBoardFile(id, version.id, version.commentId)
      const file = await call('board-comment-file', { id, fileId: version.id, commentId: version.commentId })
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mime)) return
      setPreview({ name: file.name, src: 'data:' + file.mime + ';base64,' + file.bytes })
    } catch (cause) { setError(cause.message) }
  }
  const items = (page.data?.artifacts ?? []).filter(item => !filter ||
    (filter === 'other' ? !/^(image|video|text)\//.test(item.mime) : item.mime.startsWith(filter + '/')))
  return h('section', { className: 'wb-artifact-panel' },
    h('select', { value: filter, className: 'wb-pill-select', onChange: e => { setFilter(e.target.value); setPreview(null) }, 'aria-label': t('Artifact type') },
      ...[['', 'All files'], ['image', 'Images'], ['video', 'Video'], ['text', 'Text'], ['other', 'Other']]
        .map(([id, name]) => h('option', { value: id, key: id }, t(name)))),
    page.error || error ? h('p', { className: 'gb-alert', role: 'alert' }, page.error || error) : null,
    page.data && !items.length ? h('p', { className: 'wb-subtext' }, t('No matching artifacts.')) : null,
    preview ? h('div', { className: 'wb-section-card' }, button(t('Close preview'), () => setPreview(null), { className: 'wb-btn' }), h('img', { src: preview.src, alt: preview.name })) : null,
    ...items.map(item => h('section', { key: item.id, className: 'wb-artifact' },
      h('strong', null, item.name, ' · v', item.versions.at(-1).version),
      ...[...item.versions].reverse().map(version => h('div', { key: version.id, className: 'wb-tools' },
        h('span', { className: 'wb-card-id' }, 'v', version.version),
        h('small', { className: 'wb-subtext' }, stamp(version.at), ' · ', Math.ceil(version.size / 1024), ' KB'),
        /^image\/(png|jpeg|webp|gif)$/.test(item.mime) ? button(t('Preview'), () => void download(version, true), { className: 'wb-btn' }) : null,
        button(t('Download attachment'), () => void download(version), { className: 'wb-btn' }),
        button(t('Go to source comment'), () => openComment(id, version.commentId), { className: 'wb-btn' }))))),
  )
}
