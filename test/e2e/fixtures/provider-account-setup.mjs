import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./provider-account-runner.mjs', import.meta.url))

export async function prepareProviderAccounts(scratch, host, registry) {
  const audit = join(scratch, 'guest-probe.jsonl')
  await writeFile(audit, '', { mode:0o600 })
  const local = '#!/bin/sh\ncase "$*" in\n *--version*) echo "2.0.0";;\n *"auth status"*) echo \'{"loggedIn":false}\';;\n *"login status"*) echo "Not logged in"; exit 1;;\n *) exit 1;;\nesac\n'
  for (const cli of ['agy','codex','claude','opencode'])
    await writeFile(join(host.bin,cli), local, { mode:0o700 })
  const roots = {}
  for (const slot of ['alpha','beta']) {
    const hostPath = join(await realpath(host.root), 'project-' + slot)
    await mkdir(hostPath)
    roots[slot] = hostPath
    const id = 'test-' + slot
    const runner = [process.execPath,fixture,audit,slot]
    const manifest = { id, name:'Sandbox ' + slot, uid:1000, machineId:(slot==='alpha'?'1':'2').repeat(32),
      ssh:[...runner,'ssh'], start:[...runner,'start'],
      programs:{antigravity:'/opt/fixture/agy',claude:'/opt/fixture/claude',codex:'/opt/fixture/codex'},
      workspaces:[{hostPath,guestPath:'/project',filesystem:'virtiofs',source:'test-export-'+slot,readOnly:false}] }
    await writeFile(join(registry,id+'.json'), JSON.stringify(manifest), { mode:0o600 })
  }
  return { roots, audit:async () => (await readFile(audit,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)) }
}
