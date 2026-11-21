import { createElement as h, useEffect, useState } from 'react'
import {
  isPendingInteraction,
  optionsOf,
  statusText,
  taskGuard,
  textOf,
  evidenceSummary,
} from './model.js'

export const button = (label, action, props = {}) =>
  h('button', { type: 'button', onClick: action, ...props }, label)
export const field = (label, input) => h('label', { className: 'gb-field' }, h('span', null, label), input)
export const option = (value, label) => h('option', { key: value, value }, label)
export const badge = (status, label = statusText(status)) =>
  h('span', { className: 'gb-status', 'data-status': status }, label)
const valueOf = (form, key) => String(form.get(key) ?? '').trim()
const submit = (name, disabled) => h('button', { type: 'submit', className: 'gb-primary', disabled }, name)
const input = (name, props = {}) => h('input', { name, required: true, ...props })
const area = (name, props = {}) => h('textarea', { name, required: true, rows: 2, ...props })
const row = (...children) => h('div', { className: 'gb-row' }, ...children)
const empty = (message) => h('p', { className: 'gb-muted' }, message)
const stamp = (value) => {
  if (value == null) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
}
export { stamp, empty, row }

function formAction(run, build, after) {
  return async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const original = JSON.stringify([...fields])
    await run(build(fields), (value) => {
      if (form.isConnected && JSON.stringify([...new FormData(form)]) === original) form.reset()
      after?.(value)
    })
  }
}

function QuestionForm({ item, run, pending }) {
  const questions = item.questions?.length
    ? item.questions
    : [{ id: 'answer', question: item.text, options: item.options }]
  const [responses, setResponses] = useState({})
  const set = (id, patch) => setResponses((old) => ({ ...old, [id]: { ...old[id], ...patch } }))
  const answers = Object.fromEntries(
    questions.map((q, index) => {
      const id = q.id ?? String(index)
      const value = responses[id] ?? {}
      return [id, [...(value.selected ?? []), ...(value.custom?.trim() ? [value.custom.trim()] : [])]]
    }),
  )
  const complete = Object.values(answers).every((values) => values.length > 0)
  const send = (e) => {
    e.preventDefault()
    if (complete)
      void run({ action: 'interaction.respond', interactionId: item.id, decision: 'answer', answer: answers })
  }
  return h(
    'form',
    { className: 'gb-form', onSubmit: send },
    questions.map((q, index) => {
      const id = q.id ?? String(index)
      const value = responses[id] ?? {}
      const choices = optionsOf(q.options)
      const choose = (target, checked) => {
        const selected = q.multiSelect
          ? checked
            ? [...(value.selected ?? []), target]
            : (value.selected ?? []).filter((o) => o !== target)
          : [target]
        set(id, { selected, ...(q.multiSelect ? {} : { custom: '' }) })
      }
      return h(
        'fieldset',
        { key: id, className: 'gb-question' },
        h('legend', null, q.question ?? q.header ?? item.text),
        q.detail && h('small', null, textOf(q.detail)),
        choices.length > 0 &&
          h(
            'div',
            { className: 'gb-checks' },
            choices.map((choice) =>
              h(
                'label',
                { key: choice.value },
                h('input', {
                  type: q.multiSelect ? 'checkbox' : 'radio',
                  name: `choice-${id}`,
                  checked: (value.selected ?? []).includes(choice.value),
                  onChange: (e) => choose(choice.value, e.target.checked),
                }),
                choice.label,
              ),
            ),
          ),
        q.intent?.kind !== 'approval' &&
          field(
            '回答内容',
            input(`answer-${id}`, {
              type: q.isSecret ? 'password' : 'text',
              required: !choices.length,
              value: value.custom ?? '',
              onChange: (e) =>
                set(id, {
                  custom: e.target.value,
                  ...(q.multiSelect || !e.target.value ? {} : { selected: [] }),
                }),
            }),
          ),
      )
    }),
    row(submit('提交回答', pending || !complete)),
  )
}

export function Interaction({ item, name, run, pending }) {
  const choices = optionsOf(item.options)
  const question = /question|elicit|ask|input/i.test(item.type)
  const respond = (decision) => run({ action: 'interaction.respond', interactionId: item.id, decision })
  return h(
    'article',
    { className: 'gb-interaction' },
    row(h('strong', null, question ? 'Agent 提问' : '工具审批'), h('small', null, name)),
    !question && h('div', { className: 'gb-text' }, textOf(item.text)),
    (item.details ?? item.detail) && h('pre', null, textOf(item.details ?? item.detail)),
    item.error && h('div', { role: 'alert' }, textOf(item.error)),
    isPendingInteraction(item)
      ? question
        ? h(QuestionForm, { item, run, pending })
        : row(
            ...choices.map((choice) =>
              button(choice.label, () => respond(choice.value), { key: choice.value, disabled: pending }),
            ),
            !choices.length && button('拒绝', () => respond('deny'), { disabled: pending }),
          )
      : badge(item.status),
  )
}

const transferable = new Set([
  'waiting',
  'blocked',
  'assigned',
  'working',
  'awaiting-report',
  'reported',
  'failed',
])

function TaskOperations({ task, bots, run, pending }) {
  const [draft, setDraft] = useState(null)
  const [evidence, setEvidence] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const eligible = bots.filter((member) => member.id !== task.ownerId)
  const begin = (kind) => {
    setDraft({ kind, guard: taskGuard(task), evidenceRevision: task.evidenceRevision })
    setEvidence('')
    setOwnerId('')
  }
  const stale =
    draft &&
    (draft.guard.expectedRevision !== task.revision ||
      draft.guard.expectedOwnerId !== task.ownerId ||
      draft.evidenceRevision !== task.evidenceRevision)
  const commit = async (event) => {
    event.preventDefault()
    if (!draft || stale || pending) return
    const { kind, guard } = draft
    let request = { action: `task.${kind}`, ...guard }
    if (kind === 'transfer') request.ownerId = ownerId
    if (kind === 'report' || kind === 'review') {
      request.evidence = evidence.trim()
      request.expectedEvidenceRevision = draft.evidenceRevision
      if (kind === 'review') request.approve = event.nativeEvent.submitter?.value === 'approve'
    }
    await run(request, () => setDraft((current) => (current === draft ? null : current)))
  }
  const report = ['assigned', 'working', 'awaiting-report', 'reported'].includes(task.status)
  return h(
    'div',
    { className: 'gb-stack' },
    row(
      report &&
        button(task.status === 'reported' ? '补充证据' : '报告任务结果', () => begin('report'), {
          disabled: pending,
        }),
      task.status === 'reported' && button('验收任务', () => begin('review'), { disabled: pending }),
      transferable.has(task.status) &&
        eligible.length > 0 &&
        button('移交任务', () => begin('transfer'), { disabled: pending }),
      task.status === 'failed' && button('重试任务', () => begin('retry'), { disabled: pending }),
    ),
    draft &&
      h(
        'form',
        { className: 'gb-form', onSubmit: commit },
        stale && h('small', { role: 'status' }, '负责人、状态或证据已经更新，请重新选择任务操作。'),
        draft.kind === 'transfer' &&
          field(
            '新负责人',
            h(
              'select',
              {
                name: 'transferOwner',
                required: true,
                value: ownerId,
                onChange: (e) => setOwnerId(e.target.value),
              },
              option('', '请选择 Bot'),
              ...eligible.map((member) => option(member.id, member.name)),
            ),
          ),
        ['report', 'review'].includes(draft.kind) &&
          field(
            '证据或验收意见',
            area('evidence', { value: evidence, onChange: (e) => setEvidence(e.target.value) }),
          ),
        row(
          draft.kind === 'review'
            ? ['approve', 'reject'].map((value) =>
                h(
                  'button',
                  { type: 'submit', key: value, value, disabled: pending || stale },
                  value === 'approve' ? '验收通过' : '退回修改',
                ),
              )
            : submit(
                { transfer: '确认移交', retry: '确认重试', report: '提交结果' }[draft.kind],
                pending || stale,
              ),
          button('取消操作', () => setDraft(null)),
        ),
      ),
  )
}

function Evidence({ label, value }) {
  const { full, summary, expandable } = evidenceSummary(value)
  if (!full) return null
  if (!expandable) return h('p', { className: 'gb-evidence' }, h('small', null, label), ' ', full)
  return h(
    'details',
    { className: 'gb-evidence' },
    h('summary', { title: `展开${label}` }, h('small', null, label), ' ', summary),
    h('pre', null, full),
  )
}

export function TaskBoard({ workspace, bots, tasks, run, pending, readOnly, focusTaskId, openBot }) {
  useEffect(() => {
    if (focusTaskId) document.getElementById('gb-task-' + focusTaskId)?.focus()
  }, [focusTaskId])
  const counts = new Map()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  const prerequisites = tasks.filter(task => task.status !== 'skipped')
  const totals = [...counts].map(([status, count]) => `${statusText(status)} ${count}`).join(' · ')
  return h(
    'section',
    { className: 'gb-stack' },
    h('div', { className: 'gb-sectionhead' }, h('h2', null, '任务板'), totals && h('small', null, totals)),
    h(
      'details',
      { className: 'gb-section' },
      h('summary', null, '分配任务'),
      h(
        'form',
        {
          className: 'gb-form',
          onSubmit: formAction(run, (data) => ({
            action: 'task.create',
            teamId: workspace.id,
            title: valueOf(data, 'title'),
            ownerId: valueOf(data, 'ownerId'),
            criteria: valueOf(data, 'criteria'),
            dependsOn: data.getAll('dependsOn'),
          })),
        },
        field('任务名称', input('title')),
        field(
          '负责人',
          h(
            'select',
            { name: 'ownerId', required: true },
            bots.map((bot) => option(bot.id, bot.name)),
          ),
        ),
        field('验收条件', area('criteria')),
        prerequisites.length > 0 &&
          h(
            'div',
            { className: 'gb-checks' },
            h('span', null, '依赖任务'),
            ...prerequisites.map((task) =>
              h(
                'label',
                { key: task.id },
                h('input', { name: 'dependsOn', type: 'checkbox', value: task.id }),
                task.workflowNodeId ? task.title + ' · ' + task.runId.slice(0, 8) : task.title,
              ),
            ),
          ),
        row(submit('创建任务', pending || readOnly || !bots.length)),
      ),
    ),
    !tasks.length && empty('尚未分配任务。'),
    tasks.map((task) => {
      const owner = bots.find(bot => bot.id === task.ownerId)
      return h(
        'article',
        { className: 'gb-card', key: task.id, id: 'gb-task-' + task.id, tabIndex: -1 },
        row(h('h3', null, task.title), badge(task.status)),
        h(
          'small',
          null,
          '负责人 · ', owner
            ? button(owner.name, () => openBot(owner), { title: '打开负责 Bot 的当前会话' })
            : 'Bot 已不可访问',
          task.workflowNodeId && ' · 工作流运行 ' + task.runId.slice(0, 8),
        ),
        h('p', { className: 'gb-text' }, `验收条件 · ${textOf(task.criteria) || '—'}`),
        task.dependsOn?.length > 0 &&
          h(
            'p',
            null,
            `依赖 · ${task.dependsOn.map((id) => tasks.find((item) => item.id === id)?.title ?? id).join('、')}`,
          ),
        task.evidence && h(Evidence, { label: '证据', value: task.evidence }),
        task.review &&
          textOf(task.review).trim() !== textOf(task.evidence).trim() &&
          h(Evidence, { label: '验收意见', value: task.review }),
        task.failure &&
          h(
            'p',
            { className: 'gb-text' },
            `失败 · ${[task.failure.kind, task.failure.reason].filter(Boolean).join(' · ') || textOf(task.failure)}`,
          ),
        task.blockedBy?.length > 0 &&
          h(
            'p',
            null,
            `阻塞 · ${[task.blockedBy]
              .flat()
              .map((id) => tasks.find((row) => row.id === id)?.title ?? id)
              .join('、')}`,
          ),
        task.pendingOwnerId &&
          h(
            'p',
            null,
            `等待移交 · ${bots.find((row) => row.id === task.pendingOwnerId)?.name ?? task.pendingOwnerId}`,
          ),
        !readOnly && h(TaskOperations, { task, bots, run, pending }),
      )
    }),
  )
}
