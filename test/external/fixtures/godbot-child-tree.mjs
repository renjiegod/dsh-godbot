// Creates both a normal grandchild and one which changed its POSIX group.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
const children = [false, true].map((detached) =>
  spawn(process.execPath, ['-e', script], { detached, stdio: 'ignore' }),
)
writeFileSync(process.argv[2], JSON.stringify(children.map((child) => child.pid)))
await import('./fake-claude.mjs')
