import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acpOptions, appliedPicks, claudeSpeedOption, codexSpeedOption, nativeOptions, patchModelOptions, publicOptions,
} from '../../src/host/team-runtime/core/local-agents/model-options.js'
import { CodexEngine as TeamCodexEngine } from '../../src/host/team-runtime/core/local-agents/codex.js'
import { CodexEngine as NativeCodexEngine } from '../../src/drivers/external/codex.js'
import { AcpEngine } from '../../src/host/team-runtime/core/local-agents/acp.js'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { ClaudeControlSession, configureClaudeSpeed } from '../../src/drivers/external/claude-settings.js'

// What Codex 0.172 lists for a model with two extra tiers.
const SOL = {
  id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  serviceTiers: [
    { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' },
  ],
  additionalSpeedTiers: ['fast', 'ultrafast'],
  defaultServiceTier: null,
}

test('a Codex model with service tiers offers one speed control, Standard first', () => {
  const option = codexSpeedOption(SOL)
  assert.deepEqual(option, {
    id: 'speed', type: 'select', name: 'Speed', defaultValue: 'standard',
    values: [
      { id: 'standard', name: 'Standard', native: 'default' },
      { id: 'fast', name: 'Fast', description: '2x speed, increased usage', native: 'priority' },
      { id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.', native: 'ultrafast' },
    ],
  })
  // The user's config picks the default the Bot follows until it has a pick.
  assert.equal(codexSpeedOption(SOL, 'fast').defaultValue, 'fast')
  assert.equal(codexSpeedOption(SOL, 'priority').defaultValue, 'fast')
  assert.equal(codexSpeedOption(SOL, 'flex').defaultValue, 'standard')
  // Codex before `serviceTiers` names the extra tiers only.
  assert.deepEqual(codexSpeedOption({ additionalSpeedTiers: ['fast'] }).values.map(value => [value.id, value.native]), [['standard', 'default'], ['fast', 'fast']])
  assert.equal(codexSpeedOption({ id: 'plain', serviceTiers: [] }), undefined)
  assert.equal(codexSpeedOption({ id: 'plain' }), undefined)
})

test('Claude Code offers fast mode only on the models that say they support it', () => {
  assert.deepEqual(claudeSpeedOption({ value: 'opus', supportsFastMode: true }).values.map(value => [value.id, value.native]), [['standard', false], ['fast', true]])
  assert.equal(claudeSpeedOption({ value: 'sonnet' }), undefined)
  assert.equal(claudeSpeedOption(undefined), undefined)
})

test('an ACP agent\'s own config options become options; Godbot\'s own categories do not', () => {
  const options = acpOptions([
    { id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] },
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'code', name: 'Code' }] },
    { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    { id: 'max_mode', name: 'Max Mode', description: 'Larger context', type: 'boolean', currentValue: false },
    { id: 'agent', name: 'Agent', type: 'select', currentValue: 'build', options: [{ group: 'Main', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan', description: 'Read only' }] }] },
    { id: 'lonely', name: 'Lonely', type: 'select', currentValue: 'x', options: [{ value: 'x', name: 'X' }] },
  ])
  assert.deepEqual(options, [
    { id: 'acp:max_mode', name: 'Max Mode', description: 'Larger context', native: 'max_mode', type: 'toggle', defaultValue: false },
    { id: 'acp:agent', name: 'Agent', native: 'agent', type: 'select', defaultValue: 'build',
      values: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan', description: 'Read only' }] },
  ])
  assert.deepEqual(publicOptions(options).map(option => Object.hasOwn(option, 'native')), [false, false])
})

test('a pick must be a value the model offers; clearing and other options keep working', () => {
  const offered = [codexSpeedOption(SOL), { id: 'acp:max_mode', type: 'toggle', name: 'Max Mode' }]
  assert.deepEqual(patchModelOptions(undefined, { speed: 'fast' }, offered), { speed: 'fast' })
  // Names work too, so a Bot can say what it read.
  assert.deepEqual(patchModelOptions(undefined, { speed: 'Ultrafast' }, offered), { speed: 'ultrafast' })
  assert.deepEqual(patchModelOptions({ speed: 'fast' }, { 'acp:max_mode': 'on' }, offered), { speed: 'fast', 'acp:max_mode': true })
  assert.equal(patchModelOptions({ speed: 'fast' }, { speed: null }, offered), undefined)
  // A pick kept from another model stays while the patch touches other options.
  assert.deepEqual(patchModelOptions({ 'acp:agent': 'plan' }, { speed: 'standard' }, offered), { 'acp:agent': 'plan', speed: 'standard' })
  assert.throws(() => patchModelOptions(undefined, { speed: 'warp' }, offered), /Speed warp is not available\. Available: Standard, Fast, Ultrafast/)
  assert.throws(() => patchModelOptions(undefined, { speed: 'fast' }, undefined), /This model has no speed options/)
  assert.throws(() => patchModelOptions(undefined, { 'acp:max_mode': 'maybe' }, offered), /Max Mode is on or off/)
})

test('a turn hands the CLI every offered option: the native value of a pick, else null', () => {
  const offered = [codexSpeedOption(SOL), { id: 'acp:max_mode', type: 'toggle', name: 'Max Mode' }]
  assert.deepEqual(nativeOptions(offered, { speed: 'fast', 'acp:max_mode': true }), { speed: 'priority', 'acp:max_mode': true })
  assert.deepEqual(nativeOptions(offered, undefined), { speed: null, 'acp:max_mode': null })
  // A pick another model offered is not sent.
  assert.deepEqual(nativeOptions([claudeSpeedOption({ supportsFastMode: true })], { speed: 'ultrafast' }), { speed: null })
  assert.deepEqual(nativeOptions([claudeSpeedOption({ supportsFastMode: true })], { speed: 'standard' }), { speed: false })
  assert.equal(nativeOptions(undefined, { speed: 'fast' }), undefined)
  assert.deepEqual(appliedPicks(offered, { speed: 'fast', 'acp:agent': 'plan' }), { speed: 'fast' })
})

test('the team Codex catalog carries each model\'s speeds, the config\'s default tier, and the default model\'s options', async () => {
  const engine = new TeamCodexEngine('local-codex-cli', {}, {})
  const asked = []
  engine.peer = { request(method, params) {
    asked.push(method)
    if (method === 'model/list') return { data: [SOL, { id: 'gpt-mini', displayName: 'Mini', description: 'Small', supportedReasoningEfforts: [] }] }
    if (method === 'config/read') return { config: { service_tier: 'fast', model: 'gpt-6.2-sol' } }
    throw new Error('unexpected ' + method + JSON.stringify(params))
  } }
  const models = await engine.listModels({ cwd: '/tmp' })
  assert.deepEqual(asked, ['model/list', 'config/read'])
  assert.equal(models[0].options[0].defaultValue, 'fast')
  assert.deepEqual(models[0].options[0].values.map(value => value.id), ['standard', 'fast', 'ultrafast'])
  assert.equal(models[1].options, undefined)
  assert.equal(models[1].description, 'Small')
  assert.equal(engine.defaultOptions, models[0].options)
})

test('a Codex catalog without tiers does not read the config', async () => {
  const engine = new TeamCodexEngine('local-codex-cli', {}, {})
  const asked = []
  engine.peer = { request(method) { asked.push(method); return { data: [{ id: 'plain', supportedReasoningEfforts: [] }] } } }
  await engine.listModels()
  assert.deepEqual(asked, ['model/list'])
  assert.equal(engine.defaultOptions, undefined)
})

for (const [name, Engine] of [['native', NativeCodexEngine], ['team', TeamCodexEngine]]) {
  test(`${name} Codex turns carry the Bot's tier, null for the user's own, and nothing for a model without tiers`, async () => {
    const engine = new Engine('local-codex-cli', {}, {})
    const sent = []
    engine.peer = { request(method, params) { sent.push([method, params]); return { turn: { id: 'turn-' + sent.length } } } }
    engine.ensure = async () => engine.peer
    const thread = { threadId: 'thr-1' }
    await engine.prompt(thread, [{ type: 'text', text: 'hi' }], { options: { speed: 'priority' } })
    await engine.prompt(thread, [{ type: 'text', text: 'hi' }], { options: { speed: null } })
    await engine.prompt(thread, [{ type: 'text', text: 'hi' }], {})
    assert.deepEqual(sent.map(([method, params]) => [method, Object.hasOwn(params, 'serviceTier') ? params.serviceTier : 'absent']), [
      ['turn/start', 'priority'], ['turn/start', null], ['turn/start', 'absent'],
    ])
  })
}

test('an ACP turn applies the agent\'s options, and a cleared pick hands back the value the session opened with', async () => {
  const engine = new AcpEngine('local-opencode', { name: 'OpenCode' }, {})
  const sent = []
  const session = {
    acpSessionId: 'acp-1', push() {},
    configOptions: [{ id: 'max_mode', type: 'boolean', currentValue: false }, { id: 'agent', type: 'select', currentValue: 'build' }],
  }
  engine.peer = { request(method, params) {
    sent.push([method, params])
    if (method === 'session/set_config_option') return {}
    return Promise.resolve({ stopReason: 'end_turn' })
  } }
  engine.ensure = async () => engine.peer
  await engine.prompt(session, [{ type: 'text', text: 'one' }], { options: { 'acp:max_mode': true, 'acp:agent': null, 'acp:gone': 'x' } })
  await engine.prompt(session, [{ type: 'text', text: 'two' }], { options: { 'acp:max_mode': null, 'acp:agent': null } })
  assert.deepEqual(sent.filter(([method]) => method === 'session/set_config_option').map(([, params]) => [params.configId, params.value]), [
    ['max_mode', true],
    ['max_mode', false],
  ])
})

test('a turn reads the Bot\'s picks against the model\'s options, and waits for a catalog only when the Bot has picks', async () => {
  const prompts = []
  const engine = {
    defaultOptions: [claudeSpeedOption({ supportsFastMode: true })],
    prompt(_session, _blocks, settings) { prompts.push(settings.options); return 'turn' },
    listModels: async () => [{ id: 'opus', options: [claudeSpeedOption({ supportsFastMode: true })] }],
    close: async () => {},
  }
  let picks
  const adapter = new LocalAgentAdapter({ customAgents: () => [], modelOptions: () => picks, probeCwd: () => '/tmp', spawnEngine: () => engine })
  adapter.engines.set('local-claude-code', engine)
  const live = { sessionId: 's1', route: 'local-claude-code', model: 'opus', spec: { kind: 'claude' }, engine, engineSession: {}, push() {} }
  // No catalog and no picks: nothing waits and nothing is sent.
  await adapter.startTurn(live, 'hi')
  picks = { speed: 'fast' }
  await adapter.startTurn(live, 'hi')
  await adapter.startTurn({ ...live, model: 'default' }, 'hi')
  picks = undefined
  await adapter.startTurn(live, 'hi')
  assert.deepEqual(prompts, [undefined, { speed: true }, { speed: true }, { speed: null }])
})

test('Claude Code fast mode goes through the session flag overlay and is read back', async () => {
  const session = new ClaudeControlSession()
  const writes = []
  let effective = {}
  session.write = async (message) => {
    writes.push(message.request)
    const { subtype } = message.request
    if (subtype === 'apply_flag_settings') effective = { ...effective, ...message.request.settings }
    const response = subtype === 'get_settings'
      ? { applied: { model: 'claude-opus-5-5', effort: 'high' }, effective: { fastMode: effective.fastMode === true ? true : undefined } }
      : {}
    queueMicrotask(() => session.receiveControl({ subtype: 'success', request_id: message.request_id, response }))
  }
  await configureClaudeSpeed(session, true)
  assert.equal(session.fastMode, true)
  await configureClaudeSpeed(session, null)
  assert.equal(session.fastMode, false)
  assert.deepEqual(writes.filter(request => request.subtype === 'apply_flag_settings').map(request => request.settings), [{ fastMode: true }, { fastMode: null }])
  // A CLI that keeps fast mode off (an organization policy, say) fails the pick.
  session.write = async (message) => {
    const response = message.request.subtype === 'get_settings' ? { applied: { model: 'claude-opus-5-5', effort: 'high' }, effective: {} } : {}
    queueMicrotask(() => session.receiveControl({ subtype: 'success', request_id: message.request_id, response }))
  }
  await assert.rejects(configureClaudeSpeed(session, true), /did not apply the selected speed/)
})
