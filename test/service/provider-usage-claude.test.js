import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const helper=fileURLToPath(new URL('../../src/host/provider-usage-claude.py',import.meta.url))
function fixture(t,mode) {
  const root=mkdtempSync(join(tmpdir(),'claude-quota-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const cli=join(root,'claude')
  writeFileSync(cli,`#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
mode=os.environ['MODE']
if sys.argv[1:]==['auth','status','--json']:
 marker=Path(os.environ['MARKER'])
 email='owner@example.test' if not marker.exists() or mode!='switched' else 'new@example.test'
 marker.touch()
 print(json.dumps({'loggedIn':mode!='signed-out','email':email,'orgId':'test'}))
else:
 assert mode!='signed-out'
 request=json.loads(sys.stdin.readline())
 assert request=={'type':'control_request','request_id':'godbot-quota','request':{'subtype':'get_usage','skip_behaviors':True}}
 assert sys.stdin.readline()==''
 assert '--no-session-persistence' in sys.argv and '--strict-mcp-config' in sys.argv and '--safe-mode' in sys.argv
 limits={'five_hour':{'utilization':0,'resets_at':'2026-11-21T12:04:03Z'},'seven_day':{'utilization':31.5,'resets_at':None},
         'seven_day_opus':{'utilization':100,'resets_at':'invalid'},'seven_day_sonnet':{'utilization':-2},
         'model_scoped':[{'display_name':'Claude Fable 5','utilization':3.5},{'display_name':'SECRET-FROM-VENDOR','utilization':10}]}
 data={'session':{'model_usage':{'other':'SECRET-SESSION'}},'subscription_type':'max','rate_limits_available':mode!='no-plan','rate_limits':limits,'behaviors':{'secret':'SECRET-PROJECT'}}
 print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':request['request_id'],'response':data}}))
`,{mode:0o700})
  const result=spawnSync('python3',['-I',helper,'claude',cli],{env:{...process.env,MODE:mode,MARKER:join(root,'before')},encoding:'utf8'})
  assert.equal(result.status,0)
  assert.equal(result.stderr,'')
  assert.doesNotMatch(result.stdout,/SECRET|orgId|new@example/)
  return JSON.parse(result.stdout)
}
test('native Claude usage projects zero/fractional/per-model windows and discards private metadata',t=>{
  const value=fixture(t,'ok')
  assert.equal(value.status,'available')
  assert.equal(value.email,'owner@example.test')
  assert.equal(value.plan,'max')
  assert.deepEqual(value.windows.map(w=>[w.id,w.usedPercent,w.resetsAt]),[
    ['five_hour',0,'2026-11-21T12:04:03Z'],['seven_day',31.5,null],['seven_day_opus',100,null],['seven_day_fable_5',3.5,null]])
})
test('Claude never queries quota for a signed-out user or assigns a reading across changed account identities',t=>{
  assert.equal(fixture(t,'signed-out').status,'signed-out')
  const changed=fixture(t,'switched')
  assert.equal(changed.status,'unavailable');assert.deepEqual(changed.windows,[]);assert.equal(changed.email,null)
  assert.equal(fixture(t,'no-plan').reason,'not-reported')
})
