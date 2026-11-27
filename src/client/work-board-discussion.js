import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { call } from './team-ui/api.js'
import { dateLocale, mdLabels, t } from './team-ui/i18n.js'
import { MarkdownText, writeClipboard } from './team-ui/dsh-primitives.js'
import { useWorkBoardDiscussion } from '../host/team-runtime/shared/work-board-discussion.js'
import {
  chooseCommentAddress, commentAddress, commentFileCount, commentFileLimit, commentLength,
  commentLink, commentPlan, commentReactions, commentRunLabels, commentModes, quoteRanges,
} from '../team/work-board-discussion-format.js'

const button = (label, onClick, props) => h('button', { type: 'button', onClick, ...props }, label)
const stamp = (at) => new Date(at).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' })
const blank = () => ({ body: '', parent: null, edit: null, files: [], keep: [], quiet: false })
const uuid = () => crypto.randomUUID()
const noBots = []

async function encodeFile(file) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error(t('Could not read the attachment.')))
    reader.readAsDataURL(file)
  })
  return { name: file.name, mime: file.type, size: file.size, data }
}

export function WorkBoardDiscussionPanel({ id, active, offline, focus, subscribe, openExecution, openRun, openComment, createSubtask, quote }) {
  const state = useWorkBoardDiscussion({ call, subscribe, id, active, online: true, focus, requestId: uuid })
  const [draft, setDraft] = useState(blank)
  const [annotations, setAnnotations] = useState([])
  const [annotation, setAnnotation] = useState(null)
  const [modes, setModes] = useState({})
  useEffect(() => {
    if (quote && active) setAnnotation({ source: quote.text ?? '', quote: quote.quote ?? '', note: '', start: quote.start, end: quote.end })
  }, [quote, active])
  const [error, setError] = useState(null)
  const [selectedAction, setSelectedAction] = useState(null)
  const [target, setTarget] = useState(focus)
  const [cursor, setCursor] = useState(0)
  const [optionIndex, setOptionIndex] = useState(0)
  const [editingAddress, setEditingAddress] = useState(false)
  const [picking, setPicking] = useState(false)
  const [copied, setCopied] = useState(null)
  const input = useRef(null)
  const filesInput = useRef(null)
  const section = useRef(null)
  const bots = state.roots?.bots ?? noBots
  const root = state.replies?.root ?? state.roots?.entries.find(entry => entry.id === draft.parent?.rootId)
  const plan = useMemo(() => commentPlan(draft.body, bots, {
    parent: draft.parent, root, assignee: state.roots?.assignee, quiet: draft.quiet, editing: !!draft.edit,
  }), [draft.body, bots, draft.parent, root, state.roots?.assignee, draft.quiet, draft.edit])
  const notified = plan.ids.filter(botId => !draft.edit?.runs.some(run => run.botId === botId))
  const disabled = offline || !state.roots || !state.reachable || state.roots.readOnly || state.busy || picking
  const suggestions = editingAddress && !disabled ? commentAddress(draft.body, cursor, bots) : null

  useEffect(() => {
    if (!active || !target) return
    const node = section.current?.querySelector('[data-board-comment="' + target + '"]')
    if (node) {
      node.scrollIntoView({ block: 'nearest' })
      setTarget(null)
    }
  }, [active, target, state.roots, state.replies])

  function moveInput() {
    requestAnimationFrame(() => input.current?.focus())
  }

  function reply(to) {
    setDraft((prior) => ({ ...(prior.edit ? blank() : prior), parent: to }))
    state.openThread(to.rootId)
    moveInput()
  }

  function edit(entry) {
    setDraft({ ...blank(), body: entry.body, edit: entry, keep: entry.attachments, quiet: entry.quiet })
    moveInput()
  }

  function choose(bot) {
    const selected = chooseCommentAddress(draft.body, suggestions, bot)
    setDraft({ ...draft, body: selected.body })
    setEditingAddress(false)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(selected.cursor, selected.cursor)
    })
  }

  async function attach(files) {
    const picked = [...files]
    const all = [...draft.keep, ...draft.files, ...picked]
    if (!picked.length) return
    if (all.length > commentFileCount || all.reduce((sum, file) => sum + file.size, 0) > commentFileLimit) {
      setError(t('Attach up to five files totaling 2 MB.'))
      return
    }
    setPicking(true)
    setError(null)
    try {
      const encoded = await Promise.all(picked.map(encodeFile))
      setDraft(prior => ({ ...prior, files: [...prior.files, ...encoded] }))
    } catch (cause) {
      setError(cause.message)
    } finally {
      setPicking(false)
    }
  }

  async function download(entry, file) {
    setError(null)
    try {
      const data = await call('board-comment-file', { id, commentId: entry.id, fileId: file.id })
      const bytes = Uint8Array.from(atob(data.bytes), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.download = data.name
      link.href = url
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) {
      setError(cause.message)
    }
  }

  function startAnnotation(entry, quote = '') {
    reply(entry)
    setAnnotation({ commentId: entry.id, source: entry.body, quote, note: '' })
  }
  function addAnnotation() {
    const range = annotation.start !== undefined
      ? { start: annotation.start, end: annotation.end, quote: annotation.quote }
      : quoteRanges(annotation.source, annotation.quote)[0]
    if (!range || !annotation.note.trim()) return
    setAnnotations(old => [...old, { ...range, note: annotation.note, commentId: annotation.commentId }])
    setAnnotation(null)
  }
  async function submit(event) {
    event.preventDefault()
    if (disabled || !(draft.body.trim() || draft.files.length || draft.keep.length || annotations.length)) return
    setError(null)
    const result = await state.write({
      op: draft.edit ? 'edit' : 'post',
      commentId: draft.edit?.id,
      expectedRevision: draft.edit?.revision,
      parentId: draft.parent?.id,
      body: draft.body,
      files: draft.files,
      keepFiles: draft.keep.map(file => file.id),
      quiet: draft.quiet,
      targets: notified,
      ...(annotations.length ? { annotations } : {}),
      ...(Object.keys(modes).length ? { modes } : {}),
    }, draft.parent?.rootId ?? (draft.edit?.parentId ? draft.edit.rootId : null))
    if (result) {
      setDraft(blank())
      setModes({})
      setAnnotations([])
      setAnnotation(null)
      setTarget(result.commentId)
      setEditingAddress(false)
    }
  }

  const author = (entry) => entry.author ?? t('You')
  const select = (id, kind) => setSelectedAction((value) => value?.id === id && value.kind === kind ? null : { id, kind })
  function comment(entry) {
    const actions = selectedAction?.id === entry.id ? selectedAction.kind : null
    const chosen = focus === entry.id
    return h('article', {
      className: 'wb-comment',
      key: entry.id,
      'data-board-comment': entry.id,
      'data-linked': chosen || undefined,
      'data-reply': !!entry.parentId || undefined,
      'aria-label': entry.deleted ? t('Deleted comment') : t('Comment by {name}', { name: author(entry) }),
    },
    h('div', { className: 'wb-comment-head' },
      h('span', { className: 'wb-comment-avatar', 'aria-hidden': true, 'data-bot': entry.authorType === 'bot' },
        entry.deleted ? '–' : Array.from(author(entry))[0]),
      h('strong', null, entry.deleted ? t('Deleted comment') : author(entry)),
      h('time', { dateTime: new Date(entry.createdAt).toISOString() }, stamp(entry.createdAt)),
      entry.editedAt ? h('small', null, t('Edited')) : null,
      entry.resolvedAt ? h('small', { className: 'wb-comment-resolved' }, t('Resolved')) : null,
    ),
    entry.parent && entry.parentId !== entry.rootId
      ? h('p', { className: 'wb-comment-quote' }, entry.parent.deleted
          ? t('Deleted comment') : (entry.parent.author ?? t('You')) + ' · ' + entry.parent.excerpt) : null,
    entry.body ? h('div', { className: 'wb-comment-body', onMouseUp: event => {
      const selected = window.getSelection()
      if (disabled || !selected || selected.isCollapsed || !event.currentTarget.contains(selected.anchorNode)
        || !event.currentTarget.contains(selected.focusNode)) return
      const text = selected.toString().trim()
      if (text && quoteRanges(entry.body, text).length) startAnnotation(entry, text)
    } },
      h(MarkdownText, { text: entry.body, labels: mdLabels(), variant: 'compact' })) : null,
    ...(entry.annotations ?? []).map((note, i) => h('blockquote', { key: i, className: 'wb-annotation' },
      h('pre', null, note.quote), h('p', null, note.note))),
    entry.conclusion && button(t('Conclusion') + ' · ' + entry.conclusion.excerpt, () => openComment(entry.conclusion.id)),
    entry.attachments.length ? h('div', { className: 'wb-comment-tools' }, ...entry.attachments.map(file =>
      button(file.name, () => void download(entry, file), { key: file.id, title: t('Download attachment') }))) : null,
    entry.runs.length || entry.unmatched ? h('div', { className: 'wb-comment-runs', 'aria-label': t('Comment executions') },
      ...entry.runs.map(run => h('div', { className: 'wb-comment-run', key: run.id },
        h('span', null, (run.name ?? t('Bot')) + ' · ' + t(commentRunLabels[run.state] ?? 'Unknown')),
        run.reason ? h('small', null, run.reason) : null,
        openRun ? button(t('View run'), () => openRun(run.id)) : (run.sessionId ? button(t('Open execution conversation'), () => openExecution(run)) : null))),
      entry.unmatched ? h('small', null, t('An @mention did not match an available Bot.')) : null) : null,
    h('div', { className: 'wb-comment-tools' },
      ...entry.reactions.map(emoji => button(emoji + ' 1', () => state.write({ op: 'react', commentId: entry.id, emoji, active: false }),
        { key: emoji, 'aria-pressed': true, disabled, title: t('Remove reaction') })),
      !entry.deleted && button(t('Reply'), () => reply(entry), { disabled }),
      !entry.deleted && button(t('React'), () => select(entry.id, 'reaction'), { disabled, 'aria-expanded': actions === 'reaction' }),
      !!entry.replyCount && button(t('Replies ({count})', { count: entry.replyCount }),
        () => state.openThread(state.threadId === entry.id ? null : entry.id), { 'aria-expanded': state.threadId === entry.id }),
      button(copied === entry.id ? t('Copied') : t('Copy comment link'), async () => {
        setError(null)
        try {
          const link = new URL(location.href)
          link.hash = commentLink(id, entry.id)
          await writeClipboard(link.href)
          setCopied(entry.id)
        } catch (cause) { setError(cause.message) }
      }),
      !entry.deleted && button('⋯', () => select(entry.id, 'menu'),
        { disabled, 'aria-label': t('Comment actions'), 'aria-expanded': actions === 'menu' }),
    ),
    actions === 'reaction' ? h('div', { className: 'wb-comment-tools', 'aria-label': t('Choose a reaction') },
      ...commentReactions.map(emoji => button(emoji, async () => {
        if (await state.write({ op: 'react', commentId: entry.id, emoji, active: !entry.reactions.includes(emoji) }))
          setSelectedAction(null)
      }, { key: emoji, disabled, 'aria-pressed': entry.reactions.includes(emoji) }))) : null,
    actions === 'menu' ? h('div', { className: 'wb-comment-tools' },
      entry.authorType === 'person' && button(t('Edit comment'), () => { edit(entry); setSelectedAction(null) }, { disabled }),
      entry.authorType === 'person' && button(t('Delete comment'), () => select(entry.id, 'delete'), { disabled }),
      entry.body && button(t('Annotate text'), () => startAnnotation(entry), { disabled }),
      createSubtask ? button(t('Create subtask from comment'), () => createSubtask(entry), { disabled }) : null,
      entry.parentId && button(t('Mark as conclusion'), async () => {
        if (await state.write({ op: 'resolve', commentId: entry.rootId, resolved: true, conclusionId: entry.id }, entry.rootId))
          setSelectedAction(null)
      }, { disabled }),
      !entry.parentId && button(t(entry.resolvedAt ? 'Reopen thread' : 'Resolve thread'), async () => {
        if (await state.write({ op: 'resolve', commentId: entry.id, resolved: !entry.resolvedAt })) setSelectedAction(null)
      }, { disabled }),
    ) : null,
    actions === 'delete' ? h('div', { className: 'wb-comment-tools', role: 'group', 'aria-label': t('Delete this comment?') },
      h('span', null, t('Delete this comment?')),
      button(t('Delete'), async () => {
        if (await state.write({ op: 'delete', commentId: entry.id, expectedRevision: entry.revision })) {
          if (draft.edit?.id === entry.id || draft.parent?.id === entry.id) setDraft(blank())
          setSelectedAction(null)
        }
      }, { disabled }),
      button(t('Cancel'), () => setSelectedAction(null)),
    ) : null,
    )
  }

  return h('section', { className: 'wb-discussion', ref: section, hidden: !active, 'aria-label': t('Discussion') },
    state.readError || state.writeError || error
      ? h('p', { className: 'wb-discussion-error', role: 'alert' }, error || state.writeError || state.readError,
          ' ', button(t('Refresh'), state.load)) : null,
    focus && state.roots && !state.roots.focusFound ? h('p', null, t('The linked comment is unavailable.')) : null,
    !state.roots ? h('p', null, t('Loading…')) : null,
    state.roots && !state.roots.entries.length ? h('p', { className: 'wb-discussion-empty' }, t('No comments yet.')) : null,
    h('div', { className: 'wb-comment-tools' },
      state.rootBefore && button(t('Latest comments'), () => state.setRootBefore(null)),
      state.roots?.next && button(t('Earlier comments'), () => state.setRootBefore(state.roots.next))),
    ...((state.roots?.entries ?? []).map(entry => h('div', { className: 'wb-thread', key: entry.id },
      comment(entry),
      state.threadId === entry.id ? h('div', { className: 'wb-replies' },
        h('div', { className: 'wb-comment-tools' },
          state.replyBefore && button(t('Latest replies'), () => state.setReplyBefore(null)),
          state.replies?.next && button(t('Earlier replies'), () => state.setReplyBefore(state.replies.next))),
        ...(state.replies?.entries ?? []).map(comment),
      ) : null,
    ))),
    h('form', { className: 'wb-comment-composer', onSubmit: submit },
      annotation ? h('section', { className: 'wb-annotation' },
        annotation.source ? h('details', null, h('summary', null, t('Source text')), h('pre', null, annotation.source)) : null,
        h('label', { className: 'wb-field' }, t('Quoted text'), h('textarea', { value: annotation.quote, rows: 2,
          readOnly: annotation.start !== undefined, onChange: e => setAnnotation({ ...annotation, quote: e.target.value }) })),
        h('label', { className: 'wb-field' }, t('Annotation'), h('textarea', { value: annotation.note, rows: 2,
          maxLength: 2000, onChange: e => setAnnotation({ ...annotation, note: e.target.value }) })),
        button(t('Add annotation'), addAnnotation, { disabled: disabled || annotations.length >= 20 || !annotation.note.trim() ||
          (annotation.start === undefined && !quoteRanges(annotation.source, annotation.quote).length) }),
        button(t('Cancel'), () => setAnnotation(null))) : null,
      ...annotations.map((note, i) => h('blockquote', { key: i, className: 'wb-annotation' },
        h('pre', null, note.quote), h('p', null, note.note),
        button(t('Remove annotation'), () => setAnnotations(old => old.filter((_, index) => index !== i))))),
      draft.edit || draft.parent ? h('div', { className: 'wb-comment-target' },
        draft.edit ? t('Edit comment') : t('Reply to {name}', { name: author(draft.parent) }),
        button(t('Cancel'), () => { setDraft(blank()); setAnnotations([]); setAnnotation(null); setModes({}) }),
      ) : null,
      h('textarea', {
        ref: input, value: draft.body, disabled, rows: 3, maxLength: commentLength,
        placeholder: t('Write a comment…'), 'aria-label': t('Comment'),
        'aria-autocomplete': 'list', 'aria-controls': suggestions ? 'wb-comment-mentions' : undefined,
        onChange: (event) => {
          setDraft({ ...draft, body: event.target.value })
          setCursor(event.target.selectionStart)
          setOptionIndex(0)
          setEditingAddress(true)
        },
        onSelect: (event) => setCursor(event.target.selectionStart),
        onKeyDown: (event) => {
          if (!suggestions || event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            setEditingAddress(false)
            event.stopPropagation()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const size = suggestions.options.length
            setOptionIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : size - 1)) % size)
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            choose(suggestions.options[optionIndex] ?? suggestions.options[0])
          }
        },
      }),
      suggestions ? h('div', { className: 'wb-mention-options', id: 'wb-comment-mentions', 'aria-label': t('Mention a Bot') },
        ...suggestions.options.map((bot, index) => button('@' + bot.name, () => choose(bot), {
          key: bot.id, className: index === optionIndex ? 'wb-mention-active' : undefined,
        }))) : null,
      draft.files.length || draft.keep.length ? h('div', { className: 'wb-comment-tools' },
        ...[...draft.keep, ...draft.files].map((file, index) => button(file.name + ' ×',
          () => setDraft(prior => ({ ...prior, keep: prior.keep.filter(f => f !== file), files: prior.files.filter(f => f !== file) })),
          { key: file.id ?? index, disabled, title: t('Remove attachment') }))) : null,
      !draft.quiet && (notified.length || plan.unmatched)
        ? h('div', { className: 'wb-comment-preview', 'aria-live': 'polite' },
            notified.length ? t('Will wake {names}', { names: bots.filter(bot => notified.includes(bot.id)).map(bot => bot.name).join(', ') }) : null,
            notified.length && plan.unmatched ? ' · ' : null,
            plan.unmatched ? t('An @mention did not match an available Bot.') : null)
        : null,
      !draft.quiet ? notified.map(botId => {
        const binding = state.roots?.activeRuns?.[botId]
        if (!binding) return null
        const hasFiles = draft.files.length || draft.keep.length
        return h('label', { key: botId, className: 'wb-field' }, bots.find(bot => bot.id === botId)?.name,
          h('select', { value: modes[botId]?.mode ?? 'queue', disabled, onChange: e => {
            const mode = e.target.value
            setModes(old => ({ ...old, [botId]: { mode, runId: binding.runId, turnId: binding.turnId } }))
          } }, ...Object.entries(commentModes).filter(([mode]) => mode !== 'steer' || binding.steer && !hasFiles)
            .map(([mode, label]) => h('option', { key: mode, value: mode }, t(label)))))
      }) : null,
      h('div', { className: 'wb-comment-tools' },
        h('input', { ref: filesInput, hidden: true, type: 'file', multiple: true, onChange: event => {
          void attach(event.target.files)
          event.target.value = ''
        } }),
        button(t('Attach files'), () => filesInput.current?.click(), { disabled }),
        h('label', null, h('input', { type: 'checkbox', checked: draft.quiet, disabled,
          onChange: event => setDraft({ ...draft, quiet: event.target.checked }) }), ' ', t('Comment without waking Bots')),
        h('button', { className: 'wb-primary', disabled: disabled || !(draft.body.trim() || draft.files.length || draft.keep.length || annotations.length) },
          t(draft.edit ? 'Save changes' : draft.parent ? 'Send reply' : 'Post comment')),
      ),
    ),
  )
}
