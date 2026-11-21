import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSlashCommands } from '../../src/host/slash-catalog.js'

// A real stdio exchange: records the requests so a lookup that starts a model turn fails the test.
const fixture = `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
const kind = process.env.TEST_CATALOG_PROTOCOL
const cwd = process.cwd()
function send(value) { console.log(JSON.stringify(value)) }
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  const method = m.method ?? m.request?.subtype
  appendFileSync(join(cwd, 'requests'), kind + ' ' + method + '\\n')
  const reply = result => send({ jsonrpc:'2.0', id:m.id, result })
  if (kind === 'claude') {
    send(null)
    send({type:'control_response', response:{request_id:m.request_id,response:{commands:[
      {name:'verify',description:'Verify a real change',argumentHint:'[task]'},
      {name:basename(cwd), description:'Project command'}, {name:'__bad'}, {name:3}
    ]}}})
  } else if (method === 'initialize') reply(process.env.RESUME ? {agentCapabilities:{sessionCapabilities:{resume:{},close:{}}}} : {})
  else if (method === 'skills/list') {
    if (m.params.cwds[0] !== cwd) throw new Error('wrong workspace')
    reply({data:[{cwd,skills:[
      {name:'paint',path:join(cwd,'SKILL.md'),description:'long',interface:{shortDescription:'Draw'},enabled:true},
      {name:'disabled',path:'missing',enabled:false}]}]})
  } else if (method === 'session/new' || method === 'session/resume') {
    if (m.params.cwd !== cwd || m.params.mcpServers.length) throw new Error('unexpected ACP session')
    if (method === 'session/resume' && m.params.sessionId !== 'a') throw new Error('wrong metadata session')
    const commands = {jsonrpc:'2.0',method:'session/update',params:{sessionId:'a',update:{
      sessionUpdate:'available_commands_update', availableCommands:[{name:'goal',description:'Set goal',input:{hint:'objective'}}]}}}
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'elsewhere',update:{
      sessionUpdate:'available_commands_update',availableCommands:[{name:'wrong-project'}]}}})
    // The same agent may advertise before or after answering session/new.
    if (process.env.EARLY === 'yes') send(commands)
    reply(method === 'session/new' ? {sessionId:'a'} : {})
    if (process.env.EARLY !== 'yes') send(commands)
  } else if (method === 'session/close') reply({})
  else if (method !== 'initialized') throw new Error('unexpected method: ' + method)
}
`
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'godbot-slash-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = join(root, 'mock-agent.mjs')
  await writeFile(cli, fixture)
  const cwd = await mkdir(join(root, 'workspace'), { recursive: true })
  return { cwd, root, options: (kind, env = {}) => ({ agent: kind, cwd, config: { command: process.execPath, args: [cli], env: { TEST_CATALOG_PROTOCOL: kind, ...env } } }) }
}

test('Claude initialize lists workspace skills before a prompt, with native help and argument hints', async (t) => {
  const { cwd, root, options } = await setup(t)
  const opts = options('claude')
  const [rows, same] = await Promise.all([listSlashCommands(opts), listSlashCommands(opts)])
  assert.deepEqual(rows, same)
  assert.deepEqual(rows.find(c => c.name === 'verify'), { name:'verify', description:'Verify a real change', inputHint:'[task]', kind:'prompt' })
  assert.ok(rows.some(c => c.name === 'workspace'))
  assert.ok(rows.some(c => c.name === 'whiteboard' && c.kind === 'terminal'))
  assert.ok(!rows.some(c => c.name === '__bad'))
  assert.equal(await readFile(join(cwd, 'requests'), 'utf8'), 'claude initialize\n')
  const other = await mkdir(join(root, 'other'), { recursive:true })
  const elsewhere = await listSlashCommands({ ...opts, cwd:other })
  assert.ok(elsewhere.some(c => c.name === 'other'))
  assert.ok(!elsewhere.some(c => c.name === 'workspace'))
})

test('Codex combines TUI commands with enabled skills from this cwd and preserves their native identity', async (t) => {
  const { cwd, options } = await setup(t)
  const rows = await listSlashCommands(options('codex'))
  assert.ok(rows.some(c => c.name === 'model' && c.kind === 'terminal'))
  assert.deepEqual(rows.find(c => c.name === 'paint'), { name:'paint', description:'Draw', kind:'skill', insertText:'$paint', skillPath:join(cwd,'SKILL.md') })
  assert.ok(!rows.some(c => c.name === 'disabled'))
  assert.equal(await readFile(join(cwd, 'requests'), 'utf8'), 'codex initialize\ncodex initialized\ncodex skills/list\n')
})

test('Antigravity reads ACP advertisements on either side of session/new, without prompting', async (t) => {
  const { cwd, options } = await setup(t)
  for (const EARLY of ['yes', 'no']) {
    const rows = await listSlashCommands(options('antigravity', { EARLY }))
    assert.deepEqual(rows.find(c => c.name === 'goal'), { name:'goal', description:'Set goal', inputHint:'objective', kind:'prompt' })
    assert.ok(rows.some(c => c.name === 'model' && c.kind === 'terminal'))
  }
  assert.equal(await readFile(join(cwd, 'requests'), 'utf8'), 'antigravity initialize\nantigravity session/new\n'.repeat(2))
})

test('live commands take precedence and no process starts for an unsupported or absent CLI', async () => {
  const options = { agent:'local-claude-code', cwd:tmpdir(), executable:'/not-an-installed-agent' }
  assert.deepEqual(await listSlashCommands(options), [])
  const rows = await listSlashCommands({ ...options, commands:[{name:'model',description:'Live model control'}] })
  assert.deepEqual(rows.filter(c => c.name === 'model'), [{name:'model',description:'Live model control',kind:'terminal'}])
  assert.deepEqual(await listSlashCommands({ ...options, agent:'dsh' }), [])
})

test('agy closes its own metadata session and reuses it on a fresh catalog scan', async (t) => {
  const { cwd, options } = await setup(t)
  const opts = options('antigravity', {RESUME:'yes'})
  assert.ok((await listSlashCommands(opts)).some(c => c.name === 'goal'))
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 60_000)
  assert.ok((await listSlashCommands(opts)).some(c => c.name === 'goal'))
  assert.equal(await readFile(join(cwd,'requests'),'utf8'), [
    'antigravity initialize','antigravity session/new','antigravity session/close',
    'antigravity initialize','antigravity session/resume','antigravity session/close','',
  ].join('\n'))
})

test('a failed metadata probe can recover without waiting for the cache TTL', async (t) => {
  const { root, options } = await setup(t)
  const opts = options('claude')
  const cli = join(root, 'mock-agent.mjs')
  await writeFile(cli, 'process.exitCode = 1\n')
  assert.ok(!(await listSlashCommands(opts)).some(c => c.name === 'verify'))
  await writeFile(cli, fixture)
  assert.ok((await listSlashCommands(opts)).some(c => c.name === 'verify'))
})

test('Claude usage aliases follow the available native command and keep explicit overrides', async () => {
  const list = commands => listSlashCommands({ agent: 'claude', commands })
  const rows = await list([{ name: 'usage' }, { name: 'stats', description: 'CLI statistics' }])
  assert.equal(rows.find(c => c.name === 'cost').kind, 'prompt')
  assert.deepEqual(rows.filter(c => c.name === 'stats').map(c => c.description), ['CLI statistics'])
  assert.ok(!(await list([{ name: 'verify' }])).some(c => c.name === 'cost'))
})
