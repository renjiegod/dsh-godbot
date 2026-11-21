import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openExternal } from '../../src/drivers/external/index.js'

const cases = [
  {kind:'antigravity', fixture:'fake-acp.mjs', method:'session/new', flags:['acp']},
  {kind:'codex', fixture:'fake-codex.mjs', method:'thread/start', flags:['app-server','--listen','stdio://']},
  {kind:'claude', fixture:'fake-claude.mjs', flags:['--print','--input-format','stream-json']},
]

for (const {kind, fixture, method, flags} of cases) {
  test(kind + ' uses the account launch and guest workdir with its existing native protocol', {timeout:10_000}, async t => {
    const hostCwd = await realpath(await mkdtemp(join(tmpdir(),'godbot-native-launch-')))
    const guestCwd = '/fixture-vm/work/project'
    const attempts = [], reportedDirectories = []
    const script = fileURLToPath(new URL('./fixtures/' + fixture, import.meta.url))
    const done = Promise.withResolvers()
    let text = false
    t.after(() => rm(hostCwd,{recursive:true,force:true}))
    const sandboxLaunch = {
      command: process.execPath, guestCwd,
      spawn(bin, argv, options) {
        attempts.push({ bin, argv, processCwd: options.cwd })
        const child = spawn(process.execPath,[script,...argv],{...options,cwd:hostCwd})
        const write = child.stdin.write.bind(child.stdin)
        child.stdin.write = (...args) => {
          const rpc = JSON.parse(args[0])
          if (rpc.method === method && rpc.params?.cwd) reportedDirectories.push(rpc.params.cwd)
          return write(...args)
        }
        return child
      },
    }
    const driver = await openExternal({kind,cwd:hostCwd,sandboxLaunch,
      config:{command:'/unavailable-on-host/agent',args:['--host-overrides-must-not-run']},
      onEvent(event) {
        if (event.type==='error') done.reject(new Error(event.text))
        if (event.type==='text') text=true
        if (event.type==='done') done.resolve(event.status)
      },
    })
    t.after(() => driver.close())
    await driver.start({turnId:'turn',text:'native sandbox fixture'})
    assert.equal(await done.promise,'completed')
    assert.ok(text)
    assert.ok(driver.nativeId)
    assert.equal(attempts.length,1)
    assert.equal(attempts[0].bin,process.execPath)
    assert.ok(flags.every(arg => attempts[0].argv.includes(arg)))
    assert.ok(!attempts[0].argv.includes('--host-overrides-must-not-run'))
    if (method) assert.deepEqual(reportedDirectories,[guestCwd])
    else assert.equal(attempts[0].processCwd, guestCwd)
  })
}
