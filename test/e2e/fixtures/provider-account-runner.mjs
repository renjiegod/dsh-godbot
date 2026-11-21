import { appendFileSync } from 'node:fs'

const [audit, slot, operation, ...argv] = process.argv.slice(2)
const action = operation === 'start' ? 'start' : argv.includes('-R') ? 'tunnel' : argv[argv.indexOf('-c') + 2]
appendFileSync(audit, JSON.stringify({ slot, action }) + '\n')
switch (action) {
  case 'start':
  case 'stop':
    break
  case 'identity': {
    const signedIn = slot === 'alpha'
    console.log(JSON.stringify({ status: signedIn ? 'signed-in' : 'signed-out', email: signedIn ? 'alpha@example.test' : null }))
    break
  }
  case 'usage':
    console.log(JSON.stringify({ status:'available',email:slot+'@example.test',plan:'Fixture quota',
      windows:[{id:'primary',label:'5h',usedPercent:20,windowMinutes:300,resetsAt:new Date(Date.now()+3600000).toISOString()}] }))
    break
  case 'tunnel':
    console.log('ready')
    process.stdin.resume()
    break
  case 'check':
    console.log('ready')
    break
  case 'stdio':
    // Count actual synthetic CLI completions independently of the Host journal.
    // Skip every other protocol field so this audit contains only counters.
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = (data,...options) => {
      const response = JSON.parse(String(data))
      if (response.result?.usage) appendFileSync(audit, JSON.stringify({slot,action:'synthetic-usage',usage:response.result.usage})+'\n')
      else if (response.result?.stopReason === 'end_turn') appendFileSync(audit, JSON.stringify({
        slot, action:'synthetic-no-usage', processId:process.pid, requestId:response.id,
      })+'\n')
      return write(data,...options)
    }
    if (slot === 'beta') process.argv.push('--no-usage')
    await import('../../external/fixtures/fake-acp.mjs')
    break
  default:
    process.exitCode = 2
}
