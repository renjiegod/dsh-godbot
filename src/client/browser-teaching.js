import { createElement as h, useEffect, useState } from 'react'

function button(label, onClick, disabled) {
  return h('button', { type: 'button', onClick, disabled }, label)
}

function describe(step) {
  const actions = { click: '点击', navigate: '打开', fill: '输入', key: '按键', scroll: '滚动' }
  return [
    actions[step.action], step.origin,
    step.element && (step.field ?? step.element) + (step.index ? ' #' + step.index : ''),
    step.direction === 'up' ? '向上' : step.direction === 'down' ? '向下' : step.key,
    step.destination && '→ ' + step.destination,
  ].filter(Boolean).join(' · ')
}

export function BrowserTeachingPanel({ call, lease, canRecord, recording }) {
  const [goal, setGoal] = useState('')
  const [records, setRecords] = useState([])
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    call('teaching.list').then(
      value => { if (!disposed) setRecords(value.records) },
      failure => { if (!disposed) setError(failure.message) },
    )
    return () => { disposed = true }
  }, [call, recording?.id])

  const perform = async (action, values, success) => {
    setWorking(true)
    setError('')
    setNotice('')
    try {
      const result = await call('teaching.' + action, values)
      setNotice(success?.(result) ?? '')
      if (action === 'stop' || action === 'remove') setRecords((await call('teaching.list')).records)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setWorking(false)
    }
  }

  return h('details', { className: 'gb-browser-teaching' },
    h('summary', null, recording ? '正在录制示范 · ' + recording.count + ' 步' : '浏览器示范'),
    h('p', { className: 'gb-modal-note' }, '接管网页后录制操作。示范仅保存网页来源和步骤，用于生成待审核的 Skill。'),
    error && h('p', { role: 'alert', className: 'gb-error' }, error),
    notice && h('p', { role: 'status' }, notice),
    recording
      ? button('结束录制', () => perform('stop', { lease }, result => result ? '已保存 ' + result.steps.length + ' 个步骤' : '这次没有录到操作'), working || !canRecord)
      : h('div', { className: 'gb-modal-actions' },
        h('input', { 'aria-label': '示范目标', placeholder: '例如核对一条待审核记录', value: goal, maxLength: 400, onChange: event => setGoal(event.target.value) }),
        button('开始录制', () => perform('start', { lease, goal }), !goal.trim() || !canRecord || working)),
    ...records.slice().reverse().map(record => h('details', { key: record.id, className: 'gb-browser-demonstration' },
      h('summary', null, record.goal + ' · ' + record.steps.length + ' 步'),
      h('ol', null, ...record.steps.map((step, index) => h('li', { key: index }, describe(step)))),
      h('div', { className: 'gb-modal-actions' },
        button('整理成 Skill 提案', () => perform('draft', { id: record.id },
          result => result.existing ? '这段示范已有提案，可回 Bot 私聊查看' : 'Skill 提案已送到 Bot 私聊等待审核'), working),
        button('删除示范', () => perform('remove', { id: record.id }), working)))))
}
