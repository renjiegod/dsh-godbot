import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TITLE_MAX, firstPrompt, partTitle, requestTitle, shortLink } from '../../src/host/team-runtime/core/part-titles.js'

test('a session is named by the first thing the user asked, on one line', () => {
  assert.equal(partTitle('  what is\n\nyour   model name? '), 'what is your model name?')
  assert.equal(partTitle(''), '')
  assert.equal(partTitle(undefined), '')
  assert.equal(partTitle('让 @ClaudeCode 处理这个问题'), '让 @ClaudeCode 处理这个问题')
})

test('a pasted link reads as the end of its path, so sessions that start with one tell apart', () => {
  assert.equal(
    partTitle('continue working on https://gitlab.example.com/team/app/-/issues/2020 https://gitlab.example.com/team/app/-/issues/2021\ncontinue working on these issues'),
    'continue working on issues/2020 issues/2021 continue working on these issues',
  )
  assert.equal(partTitle('https://gitlab.example.com/team/app/-/issues/2025 fix'), 'issues/2025 fix')
  // CJK text right against a link, and the punctuation that ends a sentence, stay out of it.
  assert.equal(partTitle('处理https://github.com/org/repo/pull/12，然后合并。'), '处理pull/12，然后合并。')
  assert.equal(partTitle('see (https://example.com/docs/guide.html).'), 'see (docs/guide.html).')
  assert.equal(shortLink('https://www.example.com/'), 'example.com')
  assert.equal(shortLink('https://example.com/a%20b/c'), 'a b/c')
  assert.equal(shortLink('not a link'), 'not a link')
})

test('a long first message is cut to the title length with an ellipsis', () => {
  const long = '一'.repeat(TITLE_MAX + 20)
  const title = partTitle(long)
  assert.equal([...title].length, TITLE_MAX)
  assert.ok(title.endsWith('…'))
  assert.equal(partTitle('a'.repeat(TITLE_MAX)), 'a'.repeat(TITLE_MAX))
})

test('the first prompt is the first outline turn the user wrote in, in either outline shape', () => {
  const turns = [
    { turn: 1, seq: 6, prompt: '', response: 'Noted. I have my handoff note and carry on from here.' },
    { turn: 2, seq: 21, prompt: 'continue working on https://gitlab.example.com/te…', response: 'QA passed' },
    { turn: 3, seq: 40, prompt: 'next', response: '' },
  ]
  assert.deepEqual(firstPrompt(turns), { seq: 21, preview: 'continue working on https://gitlab.example.com/te' })
  assert.deepEqual(firstPrompt({ turns, draft: '' }), { seq: 21, preview: 'continue working on https://gitlab.example.com/te' })
  assert.equal(firstPrompt([{ turn: 1, seq: 6, prompt: '' }]), undefined)
  assert.equal(firstPrompt(undefined), undefined)
  assert.deepEqual(firstPrompt([{ turn: 1, prompt: 'hi' }]), { seq: undefined, preview: 'hi' })
})

test('a Bot request is named by the title its sender gave, on one line', () => {
  assert.equal(requestTitle('A long request about many things. More.', '  Release   Godbot\n0.2.31  '), 'Release Godbot 0.2.31')
  assert.equal(requestTitle('Count barcode scanners in the warehouse inventory', ''), 'Count barcode scanners in the warehouse inventory')
  assert.equal(requestTitle('Count barcode scanners in the warehouse inventory', '   '), 'Count barcode scanners in the warehouse inventory')
  assert.equal(requestTitle('', undefined), '')
  assert.ok(requestTitle('x', 'a'.repeat(TITLE_MAX + 5)).endsWith('…'))
})

test('without a title, a Bot request is named by its first sentence', () => {
  assert.equal(requestTitle('请协调 dsh-godbot v0.2.13 并行发布归属。godbot-Codex 刚要求我公开发布'), '请协调 dsh-godbot v0.2.13 并行发布归属')
  assert.equal(requestTitle('ModelGo PRD #2059 production promotion check (P1, read-only). Agent !112 and gateway !901 have tested heads'), 'ModelGo PRD #2059 production promotion check (P1, read-only)')
  assert.equal(requestTitle('Review only; do not edit. Target worktree: /tmp/x'), 'Review only; do not edit')
  // Only the first line counts.
  assert.equal(requestTitle('Godbot Web 0.2.6 发布交接\n用户指定由发布机器人负责发布。'), 'Godbot Web 0.2.6 发布交接')
  // A short opening runs on to the next cut, and a final mark is dropped.
  assert.equal(requestTitle('Hi. Please release 0.2.31 today.'), 'Hi. Please release 0.2.31 today')
  assert.equal(requestTitle('请发布。'), '请发布')
})

test('a cut never falls inside brackets, quotes, versions, links or times', () => {
  assert.equal(requestTitle('更正任务「Godbot 0.2.31 发版：Bot 目标放进输入框」：用户刚确认合批。'), '更正任务「Godbot 0.2.31 发版：Bot 目标放进输入框」')
  assert.equal(requestTitle('用户本轮明确授权：“after all task complete let @发布机器人 publish release”。之后再说'), '用户本轮明确授权：“after all task complete let @发布机器人 publish release”')
  assert.equal(requestTitle('ModelGo #2060 Billing !157（head 4af94ffa）生产前独立代码核对，P1。请查看'), 'ModelGo #2060 Billing !157（head 4af94ffa）生产前独立代码核对，P1')
  assert.equal(requestTitle('Ship v0.2.31 at 09:20 from https://github.com/org/repo/pull/12 today. Then report'), 'Ship v0.2.31 at 09:20 from pull/12 today')
})

test('a label before a colon or bar names the request once it is long enough', () => {
  assert.equal(requestTitle('Bot goal composer 0.2.31 发版：合批指令（Web v0.2.31 + Android 0.1.23）'), 'Bot goal composer 0.2.31 发版')
  assert.equal(requestTitle('紧急协调「Godbot 0.2.31 并行发布」｜Web main 273f249 / Android main 1ca427f。'), '紧急协调「Godbot 0.2.31 并行发布」')
  assert.equal(requestTitle('#2094 P0 资格查询契约已对齐：Web API 以配置的 Gateway 目的地调用'), '#2094 P0 资格查询契约已对齐')
  // Too short to stand alone: it runs on to the end of the sentence.
  assert.equal(requestTitle('发版请求：dsh-godbot「会话页用量按钮只显示当前 Bot」，用户已确认发版。远端状态'), '发版请求：dsh-godbot「会话页用量按钮只显示当前 Bot」，用户已确认发版')
})

test('a bracketed name, a task name and Markdown marks give the bare name', () => {
  assert.equal(requestTitle('【Godbot 统一发版协调｜左下角设置直达弹窗】gemini-1 已将 69d8ef3 合入本地 main'), 'Godbot 统一发版协调｜左下角设置直达弹窗')
  assert.equal(requestTitle('【Godbot 发布请求】\n远端状态如下'), 'Godbot 发布请求')
  // A short tag is a label, not a name: the line runs on to its first sentence.
  assert.equal(requestTitle('【发布任务】请合并 show-conversation-title 分支并发布 dsh-godbot 新版本。\n\n1. 远端'), '【发布任务】请合并 show-conversation-title 分支并发布 dsh-godbot 新版本')
  assert.equal(requestTitle('[Urgent] Please release 0.2.33 today. Then report'), '[Urgent] Please release 0.2.33 today')
  assert.equal(requestTitle('【发布任务】'), '发布任务')
  assert.equal(requestTitle('任务「Godbot Go 后端方案独立评审」。用户明确要由 godbot-ClaudeCode 分析'), 'Godbot Go 后端方案独立评审')
  assert.equal(requestTitle('任务：统一自动化发布后本地端到端验证。请独立从公开地址安装'), '统一自动化发布后本地端到端验证')
  assert.equal(requestTitle('任务「Godbot Web + Android 回合中断修复发布」已完成。'), '任务「Godbot Web + Android 回合中断修复发布」已完成')
  assert.equal(requestTitle('## Release request\nDetails follow'), 'Release request')
  assert.equal(requestTitle('- **Task**: fix the login bug. More text'), 'fix the login bug')
  // An issue number is not a heading.
  assert.equal(requestTitle('#2094 新的独立任务。'), '#2094 新的独立任务')
})
