import { createElement as h, useState } from 'react'
import { button, field, row } from './controls.js'

export function AutomationAccess({ client, team, members }) {
  const [list, setList] = useState(null)
  const [issued, setIssued] = useState(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const call = (action, args = {}) =>
    client.dispatch({ action: 'automation.' + action, teamId: team.id, ...args })
  const refresh = async () => setList(await call('list'))
  const act = async (name, args) => {
    setPending(true)
    setError('')
    setIssued(null)
    try {
      const value = await call(name, args)
      if (value.token || value.secret) setIssued(value)
      await refresh()
    } catch (cause) {
      setError(cause.message)
    } finally {
      setPending(false)
    }
  }
  const form = (name, makeArgs, ...children) =>
    h(
      'form',
      {
        className: 'gb-form',
        onSubmit: (e) => {
          e.preventDefault()
          if (!pending) void act(name, makeArgs(new FormData(e.currentTarget)))
        },
      },
      ...children,
    )
  return h(
    'details',
    {
      className: 'gb-card',
      onToggle: (e) => {
        if (e.currentTarget.open) void refresh().catch((cause) => setError(cause.message))
        else setIssued(null)
      },
    },
    h('summary', null, 'CI 与 Webhook'),
    (error || list?.listenError) && h('p', { role: 'alert', className: 'gb-error' }, error || list.listenError),
    list?.url && h('p', null, 'GODBOT_URL ', h('code', null, list.url)),
    h('h3', null, 'CI 凭据'),
    form(
      'grant',
      (fields) => ({
        label: fields.get('name'),
        scopes: fields.getAll('scope'),
        targetId: fields.get('targetId'),
      }),
      field('凭据名称', h('input', { name: 'name', required: true })),
      field(
        '凭据执行目标',
        h(
          'select',
          { name: 'targetId' },
          h('option', { value: '' }, '工作区任务和工作流'),
          ...(list?.targets ?? []).map((t) =>
            h(
              'option',
              { key: t.id, value: t.id },
              (t.id.startsWith('room/') ? '群聊 · ' : 'Bot · ') + t.name,
            ),
          ),
        ),
      ),
      row(
        ...[
          ['run', '派工'],
          ['inspect', '查看与等待'],
          ['export', '导出证据'],
        ].map(([scope, label]) =>
          h(
            'label',
            { key: scope },
            h('input', { type: 'checkbox', name: 'scope', value: scope, defaultChecked: true }),
            label,
          ),
        ),
      ),
      h('button', { type: 'submit', disabled: pending }, '签发凭据'),
    ),
    ...(list?.grants ?? [])
      .filter((g) => !g.revoked)
      .map((g) =>
        h(
          'div',
          { key: g.id, className: 'gb-row' },
          h('span', null, g.label + ' · ' + g.scopes.join(', ')),
          button('撤销', () => void act('revoke', { id: g.id }), { disabled: pending }),
        ),
      ),
    ...(list?.reviews ?? []).map((review) =>
      h(
        'section',
        { key: review.taskId },
        h('h4', null, review.title + ' · ' + review.targetId + ' · R' + review.revision),
        h('pre', null, review.evidence),
        form(
          'fullReview',
          (fields) => ({
            runId: review.runId,
            taskId: review.taskId,
            revision: review.revision,
            ...Object.fromEntries(fields),
          }),
          field(
            '处理决定',
            h(
              'select',
              { name: 'decision' },
              h('option', { value: 'accept' }, '验收本项结果'),
              h('option', { value: 'rework' }, '退回并重新执行整次任务'),
            ),
          ),
          field('验收意见', h('input', { name: 'evidence', required: true })),
          h('button', { type: 'submit', disabled: pending }, '提交验收'),
        ),
      ),
    ),
    button('刷新 CI 状态', () => void refresh().catch((cause) => setError(cause.message))),
    h('h3', null, 'Webhook'),
    form(
      'hook',
      (fields) => Object.fromEntries(fields),
      field('触发器名称', h('input', { name: 'label', required: true })),
      field(
        '执行成员',
        h(
          'select',
          { name: 'ownerId', required: true },
          ...members.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
        ),
      ),
      field('任务标题', h('input', { name: 'title', required: true })),
      field('验收标准', h('textarea', { name: 'criteria', required: true })),
      h('button', { type: 'submit', disabled: pending || !members.length }, '创建 Webhook'),
    ),
    ...(list?.hooks ?? []).map((hook) =>
      h(
        'div',
        { key: hook.id, className: 'gb-row' },
        h('span', null, hook.label),
        h('code', null, list.url + '/hooks/' + hook.id),
        button(
          hook.paused ? '恢复' : '暂停',
          () => void act('pauseHook', { id: hook.id, paused: !hook.paused }),
          { disabled: pending },
        ),
      ),
    ),
    h('h3', null, 'GitHub 公开仓库事件'),
    form(
      'githubCreate',
      (fields) => ({ ...Object.fromEntries(fields), includeLatest: fields.has('includeLatest') }),
      field('订阅名称', h('input', { name: 'label', required: true })),
      field('仓库', h('input', { name: 'repo', placeholder: 'owner/repository', required: true })),
      field('事件类型', h('input', { name: 'eventType', placeholder: '例如 PullRequestEvent，留空接收全部' })),
      field(
        '执行成员',
        h(
          'select',
          { name: 'ownerId', required: true },
          ...members.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
        ),
      ),
      field('任务标题', h('input', { name: 'title', required: true })),
      field('验收标准', h('textarea', { name: 'criteria', required: true })),
      field('创建时处理最近一条匹配事件', h('input', { type: 'checkbox', name: 'includeLatest' })),
      h('button', { type: 'submit', disabled: pending || !members.length }, '订阅仓库'),
    ),
    ...(list?.sources ?? []).map((source) =>
      h(
        'div',
        { key: source.id, className: 'gb-row' },
        h('span', null, source.label + ' · ' + source.repo),
        source.issue && h('span', { role: 'alert', className: 'gb-error' }, source.issue),
        source.lastRunId && h('code', null, source.lastRunId),
        button('检查事件', () => void act('githubPoll', { id: source.id }), {
          disabled: pending || source.paused,
        }),
        button(
          source.paused ? '恢复订阅' : '暂停订阅',
          () => void act('githubPause', { id: source.id, paused: !source.paused }),
          { disabled: pending },
        ),
      ),
    ),
    issued &&
      h(
        'div',
        { role: 'status' },
        h(
          'p',
          null,
          issued.token
            ? '将以下凭据保存到 GODBOT_TOKEN_FILE。仅显示一次。'
            : '保存 Webhook 地址和签名密钥。密钥仅显示一次。',
        ),
        h('code', null, issued.url),
        h('pre', null, issued.token || issued.secret),
        button('已保存', () => setIssued(null)),
      ),
  )
}
