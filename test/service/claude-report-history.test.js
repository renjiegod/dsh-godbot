import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile, rename, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistoricalClaudeUsage } from '../../src/host/claude-report-history.js'

const nativeId = 'a3b78312-8ff2-4b64-976d-d8f1ae51bcac'
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'godbot-usage-history-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const cwd = join(await realpath(temp), '有 空格.and-dashes')
  const configDir = join(temp, 'claude')
  const folder = join(configDir, 'projects', cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(cwd)
  await mkdir(folder, { recursive: true })
  const path = join(folder, nativeId + '.jsonl')
  const time = '2026-11-20T02:58:50.853Z'
  const text = 'One complete native\nresult'
  const defaults = { cwd, configDir, nativeId, text, time }
  const row = {
    type: 'system', subtype: 'local_command', timestamp:'2026-11-20T02:58:50.840Z',
    sessionId: nativeId, cwd, isSidechain: false, content:'<local-command-stdout>'+text+'</local-command-stdout>',
    commandRun:{command:'usage',args:''}, usageReport:{session:{total_duration_ms:1200,total_cost_usd:0.01}},
  }
  return { cwd, path, row, run: extras => readHistoricalClaudeUsage({...defaults, ...extras}),
    write: rows => writeFile(path, rows.map(x=>JSON.stringify(x)).join('\n')+'\n') }
}

test('matches only the current CLI project, exact native message, and time; exports only native usage fields', async t => {
  const f=await fixture(t)
  await f.write([ { ...f.row, sessionId: 'other' }, { ...f.row, cwd: f.cwd+'-other' },
    { ...f.row, type:'assistant' }, { ...f.row, subtype:'comment' },
    { ...f.row, commandRun:{command:'status'} }, { ...f.row, isSidechain:true },
    { ...f.row, timestamp:'2026-11-20T03:10:00Z' }, f.row ])
  assert.deepEqual(await f.run(), {durationMs:1200,totalCostUsd:0.01,models:[]})
  assert.equal(await f.run({text:'One complete native result'}),null)
  assert.equal(await f.run({time:'2026-10-01T00:00:00.000Z'}),null)
  assert.equal(await f.run({nativeId:'../some-file'}),null)
})

test('identical nearby commands, including another unprojectable candidate, are ambiguous', async t => {
  const f=await fixture(t)
  await f.write([ f.row, {...f.row,usageReport:undefined,timestamp:'2026-11-20T02:58:51.001Z'} ])
  assert.equal(await f.run(),null)
  await f.write([ {...f.row,usageReport:undefined} ])
  assert.equal(await f.run(),null)
})

test('oversize and redirected transcripts are refused rather than searched or partially matched', async t => {
  const f=await fixture(t)
  assert.equal(await f.run(),null)
  await f.write([f.row])
  const other=f.path+'.other'
  await rename(f.path,other)
  try { await symlink(other,f.path) } catch (error) { if(process.platform==='win32'&&error.code==='EPERM')return; throw error }
  assert.equal(await f.run(),null)
  await rm(f.path)
  await rename(other,f.path)
  await truncate(f.path,24*1024*1024+1)
  assert.equal(await f.run(),null)
})
