import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { CodexEngine, withOwnInstructions } from '../../src/host/team-runtime/core/local-agents/codex.js'
import { withoutNativeContext } from '../../src/host/team-runtime/core/local-agents/native-context.js'
import { botPrompt } from '../../src/host/team-runtime/core/prompt.js'
import { localAgentPresentation, MEMORY_CONTEXT } from '../../src/host/team-runtime/local-agents.js'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'

const fixture = name => fileURLToPath(new URL(`../external/fixtures/${name}`, import.meta.url))
const route = 'local-claude-code'
const text = value => [{ type: 'text', text: value }]
const system = value => ({ role: 'system', id: 'sys', content: text(value) })
const user = (id, value) => ({ role: 'user', id, content: text(value) })
const said = (id, value) => ({ role: 'assistant', id, content: text(value) })
const context = (id, value) => ({ role: 'user', id, source: { kind: 'runtime-context' }, content: text(value) })
const records = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))

test('a Bot prompt has only the blocks that apply to it', () => {
  const bot = { name: 'Ada', role: 'Research', instructions: '  Cite sources.  ' }
  const model = botPrompt(bot)
  assert.match(model, /^<identity>\nYou are Ada, a Bot on the user's team in Godbot\. Your role: Research\.\n<\/identity>/)
  assert.match(model, /<instructions_from_the_user>\nCite sources\.\n<\/instructions_from_the_user>/)
  for (const block of ['team', 'replies', 'files_and_web', 'long_conversations']) assert.match(model, new RegExp(`<${block}>[\\s\\S]+</${block}>`))
  for (const block of ['main_bot', 'groups', 'local_agent']) assert.doesNotMatch(model, new RegExp(`<${block}>`))

  const local = botPrompt({ name: 'Ada' }, { localAgent: true })
  assert.match(local, /<local_agent>[\s\S]+MCP server named "godbot"[\s\S]+<\/local_agent>/)
  // The CLI has its own file, shell and web tools; Godbot's are not there.
  assert.doesNotMatch(local, /office_render|web_search|the read tool|<instructions_from_the_user>/)

  assert.match(botPrompt(bot, { inGroup: true }), /<groups>[\s\S]+post_to_group[\s\S]+<\/groups>/)
  const main = botPrompt(bot, { main: true })
  assert.match(main, /<main_bot>[\s\S]+create_bot[\s\S]+<\/main_bot>/)
  assert.match(main, /<groups>/, 'a Main Bot runs the groups, in one or not')
  assert.equal(botPrompt(bot, { inGroup: true }), botPrompt(bot, { inGroup: true }), 'the text is byte-stable')
})

test('a local agent keeps Godbot\'s section and contexts; the memory moves to the runtime context', () => {
  const assembly = {
    variables: {},
    tools: [],
    sections: [
      { name: 'harness-identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'bot-identity', text: '<identity>…</identity>', interpolate: false },
      { name: 'bot-memory', text: '# Your memory\n- likes tea', interpolate: false },
      { name: 'tool-glob', text: 'Use the glob tool — not shell find.' },
    ],
    contexts: [
      { name: 'working-directory:current', text: 'cwd: /work' },
      { name: 'harness:source', text: 'checkout: /dsh' },
      { name: 'approval:policy', text: 'ask first' },
      { name: 'godbot-learning', text: 'skills', interpolate: false },
    ],
  }
  const presented = localAgentPresentation(assembly)
  assert.deepEqual(presented.sections.map(section => section.name), ['bot-identity'])
  assert.deepEqual(presented.contexts.map(entry => entry.name), ['working-directory:current', 'godbot-learning', MEMORY_CONTEXT])
  assert.deepEqual(presented.contexts.at(-1), { name: MEMORY_CONTEXT, text: '# Your memory\n- likes tea', interpolate: false })
  assert.equal(assembly.sections.length, 4, 'the input assembly is left as it was')
  // An empty memory adds nothing.
  const empty = localAgentPresentation({ ...assembly, sections: [{ name: 'bot-memory', text: '' }] })
  assert.equal(empty.contexts.some(entry => entry.name === MEMORY_CONTEXT), false)
})

function adapterWith(flags, recordPath, cwd = tmpdir()) {
  const saved = {}
  return new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => cwd,
    presetFor: () => 'danger-full-access', toolsFor: () => [],
    record: id => saved[id], saveRecord: (id, row) => { saved[id] = row }, patchRecord: () => {},
    spawnEngine: (_kind, id, spec) => createWorkspaceClaudeEngine(id, { ...spec, args: [fixture('fake-claude-record.mjs'), '--record', recordPath, ...flags] }, { findExecutable: () => process.execPath }),
  })
}

const ask = (adapter, messages) => Array.fromAsync(adapter.stream({
  provider: route, model: 'default', sessionId: 'part', messages, signal: AbortSignal.timeout(10_000),
}))

test('Claude Code reads the instructions from a private file it knows, and the full runtime context with the replay', { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-instructions-'))
  const recordPath = join(dir, 'record.jsonl')
  const adapter = adapterWith(['--knows-prompt-file'], recordPath)
  t.after(() => adapter.dispose())
  const instructions = '<identity>\nYou are Ada.\n</identity>\n"quotes" and $HOME stay literal'
  const memory = `The following information describes your current session:\n${'- a remembered fact\n'.repeat(200)}`
  await ask(adapter, [system(instructions), user('u0', 'earlier'), said('a0', 'noted'), context('c1', memory), user('u1', 'hello')])

  const [start, first] = records(recordPath)
  assert.equal(start.system, instructions)
  assert.ok(start.argv.includes('--append-system-prompt-file'))
  assert.equal(start.argv.includes('--append-system-prompt'), false)
  assert.equal(start.argv.some(arg => arg.includes('You are Ada')), false, 'the instructions stay off the command line')
  // The memory rides whole after the instructions, apart from the conversation.
  assert.ok(first.user.includes(memory), 'the runtime context arrives in full')
  assert.ok(first.user.indexOf(memory) < first.user.indexOf('The conversation so far'))
  assert.doesNotMatch(first.user, /User: The following information/)
  // The appended system prompt holds the instructions: the replay does not repeat them.
  assert.doesNotMatch(first.user, /team instructions|You are Ada/)
  assert.match(first.user, /User: earlier/)

  const { child } = adapter.live.get('part').engineSession
  await adapter.closeSession('part')
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve))
  await delay(50)
  assert.equal(existsSync(start.file), false, 'the file leaves with the process')
})

test('an older Claude Code gets the instructions as text; after it condenses, the runtime context comes again', { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-instructions-'))
  const recordPath = join(dir, 'record.jsonl')
  const adapter = adapterWith([], recordPath)
  t.after(() => adapter.dispose())
  const memory = 'Current runtime context: you like tea.'
  const history = [system('You are Ada.'), context('c1', memory), user('u1', 'hello')]
  await ask(adapter, history)
  history.push(said('a1', 'ok'), user('u2', 'COMPACT'))
  await ask(adapter, history)
  history.push(said('a2', 'ok'), user('u3', 'after'))
  await ask(adapter, history)
  history.push(said('a3', 'ok'), user('u4', 'later'))
  await ask(adapter, history)

  const [start, , compact, after, later] = records(recordPath)
  assert.equal(start.system, 'You are Ada.')
  assert.ok(start.argv.includes('--append-system-prompt'))
  assert.equal(start.file, undefined)
  assert.doesNotMatch(compact.user, /you like tea/)
  assert.equal(after.user, `${memory}\n\nafter`, 'the context the CLI condensed comes once more')
  assert.equal(later.user, 'later')
})

test('Codex keeps the developer instructions of the user\'s own config, on a new thread and on an update', { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-codex-'))
  const recordPath = join(dir, 'record.jsonl')
  const own = 'Always run the tests.'
  const engine = new CodexEngine('codex-test', {
    name: 'Codex', command: 'codex', args: [fixture('fake-codex.mjs'), '--record', recordPath],
    env: { FAKE_CODEX_DEVELOPER_INSTRUCTIONS: own },
  }, { findExecutable: () => process.execPath })
  t.after(() => engine.close?.())
  const thread = await engine.open('part', { cwd: tmpdir(), instructions: 'You are Ada.' })
  await engine.instruct(thread, 'Updated team instructions (replace earlier ones):\n\nYou are Ada, renamed.')

  const calls = records(recordPath)
  const started = calls.find(call => call.method === 'thread/start')
  assert.equal(started.params.developerInstructions, withOwnInstructions('You are Ada.', own))
  assert.ok(started.params.developerInstructions.endsWith(own), 'the user\'s own keep the last word')
  const read = calls.find(call => call.method === 'config/read')
  assert.equal(read.params.cwd, tmpdir())
  const injected = calls.find(call => call.method === 'thread/inject_items')
  assert.match(injected.params.items[0].text, /You are Ada, renamed\.[\s\S]+Always run the tests\.$/)
})

test('without own developer instructions Codex gets the team\'s alone', () => {
  assert.equal(withOwnInstructions('You are Ada.', undefined), 'You are Ada.')
  assert.equal(withOwnInstructions('You are Ada.', ''), 'You are Ada.')
})

function codexAdapter(recordPath, saved = {}) {
  return new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => tmpdir(),
    presetFor: () => 'danger-full-access', toolsFor: () => [],
    record: id => saved[id], saveRecord: (id, row) => { saved[id] = row }, patchRecord: () => {},
    spawnEngine: (_kind, id, spec) => new CodexEngine(id, { ...spec, args: [fixture('fake-codex.mjs'), '--record', recordPath] }, { findExecutable: () => process.execPath }),
  })
}

const askCodex = (adapter, messages) => Array.fromAsync(adapter.stream({
  provider: 'local-codex-cli', model: 'default', sessionId: 'part', messages, signal: AbortSignal.timeout(10_000),
}))

const turnText = call => call.params.input.filter(item => item.type === 'text').map(item => item.text).join('\n')

test('a new Codex thread holds the instructions as developer config, not in the replay', { timeout: 20_000 }, async (t) => {
  const recordPath = join(mkdtempSync(join(tmpdir(), 'godbot-codex-')), 'record.jsonl')
  const adapter = codexAdapter(recordPath)
  t.after(() => adapter.dispose())
  await askCodex(adapter, [system('You are Ada.'), user('u0', 'earlier'), said('a0', 'noted'), user('u1', 'hello')])

  const calls = records(recordPath)
  assert.equal(calls.find(call => call.method === 'thread/start').params.developerInstructions, 'You are Ada.')
  const turn = turnText(calls.find(call => call.method === 'turn/start'))
  assert.match(turn, /^The conversation so far \(oldest first\):/)
  assert.doesNotMatch(turn, /You are Ada|team instructions/)
  assert.equal(calls.some(call => call.method === 'thread/inject_items'), false)
})

test('a Codex thread that cannot be resumed is replaced by one with the instructions and the conversation', { timeout: 20_000 }, async (t) => {
  const recordPath = join(mkdtempSync(join(tmpdir(), 'godbot-codex-')), 'record.jsonl')
  const promptHash = createHash('sha256').update('You are Ada.').digest('hex')
  const adapter = codexAdapter(recordPath, { part: { cliSessionId: 'missing', handedId: 'a0', promptHash } })
  t.after(() => adapter.dispose())
  await askCodex(adapter, [system('You are Ada.'), user('u0', 'earlier'), said('a0', 'noted'), user('u1', 'hello')])

  const calls = records(recordPath)
  assert.equal(calls.find(call => call.method === 'thread/resume').params.threadId, 'missing')
  assert.equal(calls.find(call => call.method === 'thread/start').params.developerInstructions, 'You are Ada.')
  const turn = turnText(calls.find(call => call.method === 'turn/start'))
  assert.match(turn, /User: earlier[\s\S]+You: noted[\s\S]+User: hello/, 'the new thread hears the conversation it lost')
  assert.doesNotMatch(turn, /You are Ada/)
  assert.equal(calls.some(call => call.method === 'thread/inject_items'), false)
})

test('a resumed Codex thread hears about instructions that changed while it was away', { timeout: 20_000 }, async (t) => {
  const recordPath = join(mkdtempSync(join(tmpdir(), 'godbot-codex-')), 'record.jsonl')
  const promptHash = createHash('sha256').update('You are Ada.').digest('hex')
  const adapter = codexAdapter(recordPath, { part: { cliSessionId: 'thr-old', handedId: 'a0', promptHash } })
  t.after(() => adapter.dispose())
  await askCodex(adapter, [system('You are Ada, renamed.'), user('u0', 'earlier'), said('a0', 'noted'), user('u1', 'hello')])

  const calls = records(recordPath)
  assert.equal(calls.some(call => call.method === 'thread/start'), false)
  const injected = calls.find(call => call.method === 'thread/inject_items')
  assert.match(injected.params.items[0].text, /^Updated team instructions \(replace earlier ones\):\n\nYou are Ada, renamed\.$/)
  assert.equal(turnText(calls.find(call => call.method === 'turn/start')), 'hello')
})

// DSH's own context messages, as its skill and workspace-instruction plugins write them.
const catalog = id => ({ role: 'user', id, source: { kind: 'skill-catalog', entries: [] }, content: text('<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `dsh-doc`: DSH facts\n</available_skills>\n</system-reminder>') })
const workspaceInstructions = (id, files) => ({
  role: 'user', id, source: { kind: 'agent-instructions', form: 'instructions', baseline: true, changes: [] },
  content: text(['<system-reminder>', ['The following workspace instructions may be relevant to your work.', ...files.map(([path, body]) => `Instructions from: ${path}\n\n${body}`)].join('\n\n'), '</system-reminder>'].join('\n')),
})
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'godbot-project-'))
  mkdirSync(join(root, '.git'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    if (body.startsWith('->')) symlinkSync(body.slice(2), join(root, path))
    else writeFileSync(join(root, path), body)
  }
  return root
}
const kept = messages => messages.map(message => message.content.map(block => block.text).join('\n')).join('\n---\n')

test('a local agent CLI is not shown DSH\'s skill catalog', () => {
  for (const kind of ['claude', 'codex', 'acp']) {
    const out = withoutNativeContext([catalog('k'), user('u', 'hello')], { kind, cwd: tmpdir() })
    assert.deepEqual(out.map(message => message.id), ['u'])
  }
})

test('Claude Code is not shown the CLAUDE.md files it reads itself', () => {
  const root = project({ 'CLAUDE.md': 'claude rules', 'AGENTS.md': 'agent rules', 'app/AGENTS.md': 'app rules', 'app/CLAUDE.md': '->AGENTS.md' })
  const cwd = join(root, 'app')
  // Files end with a line break, which leaves a blank line before the next heading.
  const message = workspaceInstructions('w', [['~/.agents/AGENTS.md', 'global rules\n'], ['CLAUDE.md', 'claude rules\n'], ['AGENTS.md', 'agent rules\n'], ['app/AGENTS.md', 'app rules\n']])
  const [out] = withoutNativeContext([message], { kind: 'claude', cwd })
  const shown = kept([out])
  assert.match(shown, /^<system-reminder>\nThe following workspace instructions/)
  assert.match(shown, /Instructions from: ~\/\.agents\/AGENTS\.md\n\nglobal rules/, 'no CLI reads the user-wide file')
  assert.match(shown, /Instructions from: AGENTS\.md\n\nagent rules/, 'Claude Code does not read AGENTS.md')
  assert.doesNotMatch(shown, /claude rules/)
  assert.doesNotMatch(shown, /app rules/, 'the AGENTS.md its CLAUDE.md links to is read through the link')
  assert.match(shown, /<\/system-reminder>$/)
  // Nothing left but the files it reads: the message goes.
  assert.deepEqual(withoutNativeContext([workspaceInstructions('w', [['CLAUDE.md', 'claude rules']]), user('u', 'hi')], { kind: 'claude', cwd }).map(m => m.id), ['u'])
})

test('Codex is not shown the AGENTS.md files it reads itself', () => {
  const root = project({ 'AGENTS.md': 'agent rules', 'CLAUDE.md': 'claude rules', 'svc/AGENTS.md': 'svc rules', 'svc/AGENTS.override.md': 'override' })
  const message = workspaceInstructions('w', [['AGENTS.md', 'agent rules'], ['CLAUDE.md', 'claude rules'], ['svc/AGENTS.md', 'svc rules']])
  const shown = kept(withoutNativeContext([message], { kind: 'codex', cwd: join(root, 'svc') }))
  assert.doesNotMatch(shown, /agent rules/)
  assert.match(shown, /claude rules/)
  assert.match(shown, /svc rules/, 'an AGENTS.override.md takes the place of that AGENTS.md in Codex')
})

test('ACP agents, sandboxed CLIs and unknown layouts keep the workspace instructions', () => {
  const root = project({ 'CLAUDE.md': 'claude rules', 'AGENTS.md': 'agent rules' })
  const message = workspaceInstructions('w', [['CLAUDE.md', 'claude rules'], ['AGENTS.md', 'agent rules']])
  assert.equal(withoutNativeContext([message], { kind: 'acp', cwd: root })[0], message)
  assert.equal(withoutNativeContext([message], { kind: 'claude', cwd: root, sandboxed: true })[0], message)
  const odd = { ...message, content: text('Instructions from: CLAUDE.md\n\nclaude rules') }
  assert.equal(withoutNativeContext([odd], { kind: 'claude', cwd: root })[0], odd)
})

test('Claude Code\'s replay and later input leave out what it has of its own', { timeout: 20_000 }, async (t) => {
  const root = project({ 'CLAUDE.md': 'claude rules' })
  const recordPath = join(mkdtempSync(join(tmpdir(), 'godbot-instructions-')), 'record.jsonl')
  const adapter = adapterWith(['--knows-prompt-file'], recordPath, root)
  t.after(() => adapter.dispose())
  const rules = workspaceInstructions('w0', [['~/.agents/AGENTS.md', 'global rules\n'], ['CLAUDE.md', 'claude rules\n']])
  const first = [system('You are Ada.'), user('u0', 'earlier'), said('a0', 'noted'), rules, catalog('k0'), user('u1', 'hello')]
  await ask(adapter, first)
  await ask(adapter, [...first, said('a1', 'hi'), catalog('k1'), workspaceInstructions('w1', [['CLAUDE.md', 'claude rules, changed']]), user('u2', 'next')])

  const users = records(recordPath).filter(row => row.user !== undefined).map(row => row.user)
  assert.equal(users.length, 2)
  assert.match(users[0], /User: earlier/)
  assert.match(users[0], /global rules/)
  assert.doesNotMatch(users[0], /claude rules|available_skills/)
  assert.doesNotMatch(users[1], /claude rules|available_skills/)
  assert.match(users[1], /next/)
})
