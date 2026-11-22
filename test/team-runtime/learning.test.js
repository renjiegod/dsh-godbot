import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as learning from '../../src/host/team-runtime/core/learning.js'

const SKILL = { action: 'create', name: 'release-checks', description: 'Use before tagging a release.', content: '1. Run the release e2e.\n2. Check the tag matches the version.', why: 'The user asked for the e2e run before every tag.' }

// A team of one Bot, `b`, whose current chat part is `chat-b`.
async function team(t, { model = 'cloud/default', prefs = {}, config = {}, reply = JSON.stringify(SKILL), folder } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'godbot-learning-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'learning'))
  await writeFile(join(home, 'learning', 'state.json'), JSON.stringify({ pending: { b: ['chat-b'] } }))
  const bots = { b: { id: 'b', name: 'Builder', model, capabilities: [] } }
  const listeners = new Map()
  const disposers = []
  const contexts = []
  const shots = []
  const rt = {
    home,
    config: { learningTimes: { tickMs: 3_600_000 }, ...config },
    state: { bots, prefs, capabilities: { items: {} } },
    ctx: {
      on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]) },
      effect(fn) { const close = fn(); if (typeof close === 'function') disposers.push(close) },
      systemPrompt: { context(entry) { contexts.push(entry); return () => {} } },
    },
    botOf: id => bots[id],
    chatOf: id => `chat-${id}`,
    chatOwners: new Map([['chat-b', 'b'], ['old-part-b', 'b']]),
    isBotSession: id => rt.chatOwners.has(id),
    engineOfBot: bot => (bot.model.startsWith('local-') || bot.model.startsWith('ag-ui-') ? bot.model.split('/')[0] : 'model'),
    isRemoteAgentRef: ref => typeof ref === 'string' && ref.startsWith('ag-ui-'),
    engineNameOf: ref => (ref.startsWith('local-claude-code') ? 'Claude Code' : `the model ${ref}`),
    partLines: async function* () {
      yield { seq: 9, who: 'bot', time: 2, text: 'You: Tagged it after the e2e passed.' }
      yield { seq: 8, who: 'user', time: 1, text: 'User: Always run the release e2e before you tag.' }
    },
    botShot: async (_bot, system, text) => {
      shots.push({ system, text })
      return system === learning.skillSystem() ? reply : '{"action":"none","reason":"nothing lasting"}'
    },
    redactSecrets: text => text,
    uiLanguage: () => 'en',
    readOnly: () => undefined,
    workView: () => ({}),
    resolveAgent: async () => ({ session: {} }),
    sessionFolder: () => folder,
    real: async path => path,
    workFolder: async () => {},
    warn() {},
    save: async () => {},
    capabilitySave: async (body) => {
      rt.state.capabilities.items[body.name] = { ...body }
      return body
    },
    capabilityEndpoint: async (endpoint, body) => {
      if (endpoint === 'bot-capability') bots[body.botId].capabilities.push(body.name)
    },
    capabilityDelete: async () => {},
  }
  learning.install(rt)
  t.after(async () => { for (const close of disposers) await close() })
  const saved = async () => JSON.parse(await readFile(join(home, 'learning', 'state.json'), 'utf8'))
  const told = (sessionId = 'chat-b') => contexts[0].text({ agent: { id: sessionId } })
  return { rt, bots, shots, contexts, saved, told, listeners }
}

const skillReviews = shots => shots.filter(shot => shot.system === learning.skillSystem())
const agentsReviews = shots => shots.filter(shot => shot.system === learning.agentsSystem())

test('a Bot on a local agent gets no skill review, and its chat is still read', async (t) => {
  const { rt, shots, saved } = await team(t, { model: 'local-claude-code/opus' })
  assert.equal(await rt.learningRun(), 0)
  assert.equal(skillReviews(shots).length, 0)
  const after = await saved()
  assert.deepEqual(after.proposals, {})
  assert.deepEqual(after.pending, {})
  assert.equal(after.cursors['chat-b'], 9)
})

test('a Bot on a remote agent gets no skill review either', async (t) => {
  const { rt, shots } = await team(t, { model: 'ag-ui-x/default' })
  await rt.learningRun()
  assert.equal(skillReviews(shots).length, 0)
})

test('a Bot on a model gets its skill proposal, and its card cannot be approved once it moves to a local agent', async (t) => {
  const { rt, bots, shots } = await team(t)
  assert.equal(await rt.learningRun(), 1)
  assert.equal(skillReviews(shots).length, 1)
  const [proposal] = rt.learningView().b
  assert.equal(proposal.name, 'release-checks')
  assert.equal(proposal.unreachable, undefined)

  bots.b.model = 'local-claude-code/opus'
  assert.equal(rt.learningView().b[0].unreachable, 'local')
  await assert.rejects(rt.learningEndpoint('learning-answer', { id: proposal.id, approve: true }), /Claude Code, a local agent, which does not read team skills/)
  assert.equal(rt.learningView().b.length, 1, 'a refused approval keeps the card')
  assert.deepEqual(bots.b.capabilities, [])

  assert.deepEqual(await rt.learningEndpoint('learning-answer', { id: proposal.id, approve: false }), { applied: false })
  assert.deepEqual(rt.learningView(), {})
  assert.equal(rt.learningSettledView().b[0].outcome, 'declined')
})

test('an approved skill is saved to the team library and attached to the Bot', async (t) => {
  const { rt, bots } = await team(t)
  await rt.learningRun()
  const [proposal] = rt.learningView().b
  assert.deepEqual(await rt.learningEndpoint('learning-answer', { id: proposal.id, approve: true }), { applied: true })
  assert.equal(rt.state.capabilities.items['release-checks'].content, SKILL.content)
  assert.deepEqual(bots.b.capabilities, ['release-checks'])
})

test('the team switch stops skill proposals', async (t) => {
  const { rt, shots } = await team(t, { prefs: { learnSkills: false } })
  assert.equal(await rt.learningRun(), 0)
  assert.equal(skillReviews(shots).length, 0)
})

test('the team switch stops AGENTS.md proposals, and the config still overrides the team', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'godbot-learning-project-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await mkdir(join(folder, '.git'))

  const on = await team(t, { folder, reply: '{"action":"none","reason":"no"}' })
  await on.rt.learningRun()
  assert.equal(agentsReviews(on.shots).length, 1)
  assert.deepEqual(on.rt.learningAvailable, { skills: true, agentsMd: true })

  const off = await team(t, { folder, prefs: { learnAgentsMd: false } })
  await off.rt.learningRun()
  assert.equal(agentsReviews(off.shots).length, 0)
  assert.deepEqual((await off.saved()).agentsPending, {})

  const config = await team(t, { folder, config: { agentsMd: false } })
  await config.rt.learningRun()
  assert.equal(agentsReviews(config.shots).length, 0)
  assert.deepEqual(config.rt.learningAvailable, { skills: true, agentsMd: false })
})

test('a long turn is not marked for review while both switches are off', async (t) => {
  const { rt, listeners, saved } = await team(t, { prefs: { learnSkills: false, learnAgentsMd: false }, config: { learningTimes: { tickMs: 3_600_000, minTurnMs: 0 } } })
  await rt.learningRun()
  const status = (id, value) => listeners.get('agent/status').forEach(fn => fn({ agent: { id }, status: value }))
  status('chat-b', 'running')
  status('chat-b', 'idle')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual((await saved()).pending, {})
})

test('learning turned off by the host config offers no switches', async (t) => {
  const { rt, contexts } = await team(t, { config: { learning: false } })
  assert.deepEqual(rt.learningAvailable, { skills: false, agentsMd: false })
  assert.equal(contexts.length, 0)
})

test('the Bot is told about the cards of its current chat part, and nothing elsewhere', async (t) => {
  const { rt, told, contexts } = await team(t)
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].interpolate, false)
  assert.equal(told(), '')
  await rt.learningRun()

  const waiting = told()
  assert.match(waiting, /## Learning cards in this chat/)
  assert.match(waiting, /A new skill "release-checks", waiting for the user's answer/)
  assert.match(waiting, /When to use it: Use before tagging a release\./)
  assert.match(waiting, /Settings → Capabilities/)
  assert.match(waiting, /there is no SKILL\.md or folder on disk/)
  assert.match(waiting, / {4}2\. Check the tag matches the version\./)
  assert.equal(told('old-part-b'), '', 'an earlier part shows no cards')
  assert.equal(told('elsewhere'), '')
  assert.equal(contexts[0].text({}), '')

  const [proposal] = rt.learningView().b
  await rt.learningEndpoint('learning-answer', { id: proposal.id, approve: true })
  const approved = told()
  assert.match(approved, /A new skill "release-checks": approved\. It is saved in the team's shared capabilities/)
  assert.doesNotMatch(approved, /waiting for the user's answer/)
  assert.doesNotMatch(approved, /Run the release e2e/)
})

test('a Bot on a local agent is told that its waiting skill would not reach it', async (t) => {
  const { rt, bots, told } = await team(t)
  await rt.learningRun()
  bots.b.model = 'local-claude-code/opus'
  const text = told()
  assert.match(text, /You run on Claude Code, a local agent, which does not read team skills/)
  assert.doesNotMatch(text, /If approved, it is saved/)
})

test('learningContext lists waiting AGENTS.md edits and the latest answered cards only', () => {
  assert.equal(learning.learningContext({}), '')
  const agents = {
    kind: 'agents', folder: '/work/app', path: '/work/app/AGENTS.md',
    edits: [
      { op: 'add', after: '## Checks', text: '- Run `npm test` before a commit.', why: 'The user asked twice.' },
      { op: 'replace', old: '- Use yarn.', text: '- Use npm.', why: 'The user switched to npm.' },
      { op: 'remove', old: '- Push to main.', why: 'Pull requests only.' },
    ],
  }
  const text = learning.learningContext({ waiting: [agents] })
  assert.match(text, /A change to \/work\/app\/AGENTS\.md, waiting for the user's answer/)
  assert.match(text, /add "- Run `npm test` before a commit\." after the line "## Checks" \(why: The user asked twice\.\)/)
  assert.match(text, /replace "- Use yarn\." with "- Use npm\."/)
  assert.match(text, /remove "- Push to main\."/)

  const settled = Array.from({ length: 7 }, (_, index) => ({ kind: 'skill', action: 'create', name: `skill-${index}`, outcome: index % 2 ? 'approved' : 'declined' }))
  const told = learning.learningContext({ settled })
  assert.doesNotMatch(told, /skill-1"/)
  assert.match(told, /A new skill "skill-2": declined\. Nothing was saved/)
  assert.match(told, /A new skill "skill-6": declined/)
  assert.match(told, /A new skill "skill-5": approved/)
  assert.match(learning.learningContext({ settled: [{ ...agents, outcome: 'approved' }] }), /A change to \/work\/app\/AGENTS\.md: approved, and the file was updated\./)
})
