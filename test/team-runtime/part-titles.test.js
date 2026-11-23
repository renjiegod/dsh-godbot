import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TITLE_MAX, firstPrompt, partTitle, shortLink } from '../../src/host/team-runtime/core/part-titles.js'

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
