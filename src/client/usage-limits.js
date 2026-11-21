import { createElement as h, useState } from 'react'
import { field } from './controls.js'

const limits = {
  dailyTokens: '每日 token',
  monthlyTokens: '每月 token',
  dailyUsd: '每日估算美元',
  monthlyUsd: '每月估算美元',
}

export function UsageLimits({ client, bots, models }) {
  const [subject, setSubject] = useState('profile')
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function load(id, settings) {
    setBusy(true)
    setError('')
    try {
      const result = await client.dispatch({
        action: settings ? 'budget.configure' : 'budget.view',
        subject: id,
        settings,
      })
      setState(result)
      setSubject(id)
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }
  const s = state?.settings
  return h(
    'details',
    {
      className: 'gb-card',
      onToggle: (e) => {
        if (e.currentTarget.open) void load(subject)
      },
    },
    h('summary', null, '用量上限与备用模型'),
    h(
      'form',
      {
        className: 'gb-form',
        onSubmit: (e) => {
          e.preventDefault()
          void load(new FormData(e.currentTarget).get('subject'))
        },
      },
      field(
        '适用范围',
        h('select', {
          name: 'subject',
          defaultValue: subject,
          required: true,
        }, h('option', { value: 'profile' }, '整个 profile'),
          bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
      ),
      h('button', { disabled: busy }, '查看用量与设置'),
    ),
    error && h('p', { role: 'alert' }, error),
    s &&
      h(
        'form',
        {
          key: state.subject + '-' + JSON.stringify(s),
          className: 'gb-form',
          onSubmit: (e) => {
            e.preventDefault()
            try {
              const fields = new FormData(e.currentTarget)
              const values = { stops: fields.get('stops') }
              for (const key of Object.keys(limits)) if (fields.get(key)) values[key] = Number(fields.get(key))
              if (subject === 'profile') values.rates = JSON.parse(fields.get('rates') || '{}')
              const backup = models.find((m) => m.provider + '/' + m.model === fields.get('backup'))
              if (backup) values.backup = { provider: backup.provider, model: backup.model }
              void load(subject, values)
            } catch (cause) {
              setError(cause.message)
            }
          },
        },
        h(
          'p',
          null,
          'UTC 今日 ' +
            state.daily.tokens +
            ' token · 本月 ' +
            state.monthly.tokens +
            ' token · 已定价部分约 $' +
            state.monthly.estimatedUsd.toFixed(4),
        ),
        h(
          'p',
          null,
          '本月未定价 ' + state.monthly.unpricedCalls + ' 次，未报告用量 ' + state.monthly.unreported + ' 轮。',
        ),
        ...(state.deferred ?? []).map(item => h('p',{key:item.id},item.status === 'unknown'
        ? '投递结果待核对 · ' + item.sessionId
        : '已暂缓 · ' + item.sessionId + ' · ' + item.limit + ' · ' + new Date(item.resetsAt).toLocaleString())),
      ...(state.fallback ?? []).map((hold) =>
          h(
            'p',
            { key: hold.from },
            hold.active
              ? hold.from +
                  ' 额度已用尽，正在使用 ' +
                  hold.backup +
                  '。下次尝试原模型 ' +
                  new Date(hold.until).toLocaleString()
              : hold.recoveredAt
                ? '已恢复 ' + hold.from + ' · ' + new Date(hold.recoveredAt).toLocaleString()
                : '等待下一次调用核对 ' + hold.from,
          ),
        ),
        ...Object.entries(limits).map(([key, label]) =>
          h(
            'label',
            { key, className: 'gb-field' },
            label,
            h('input', {
              name: key,
              type: 'number',
              min: 0,
              step: key.endsWith('Usd') ? 'any' : '1',
              defaultValue: s[key] ?? '',
              placeholder: '无限制',
            }),
          ),
        ),
        field(
          '达到上限时暂停',
          h(
            'select',
            { name: 'stops', defaultValue: s.stops ?? 'unattended' },
            h('option', { value: 'unattended' }, '无人值守的新任务'),
            h('option', { value: 'all' }, '所有新任务'),
          ),
        ),
        subject === 'profile'
          ? field(
              '模型估价（每百万 token 美元）',
              h('textarea', {
                name: 'rates',
                defaultValue: JSON.stringify(s.rates ?? {}, null, 2),
                placeholder: '{"provider/model":{"input":1,"output":2}}',
              }),
            )
          : field(
              '确认模型额度耗尽时使用',
              h(
                'select',
                { name: 'backup', defaultValue: s.backup ? s.backup.provider + '/' + s.backup.model : '' },
                h('option', { value: '' }, '等待原模型恢复'),
                ...models
                  .filter((m) => !m.provider.startsWith('local-'))
                  .map((m) => {
                    const ref = m.provider + '/' + m.model
                    return h('option', { key: ref, value: ref }, ref)
                  }),
              ),
            ),
        h('button', { disabled: busy }, '保存用量策略'),
      ),
  )
}
