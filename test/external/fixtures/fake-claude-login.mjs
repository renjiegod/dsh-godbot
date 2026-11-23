// A fake `claude auth login`: it hands its loopback sign-in link to $BROWSER,
// prints the manual link and asks for a pasted code, the way Claude Code 2.1 does.
// It ends signed in (FAKE_SIGNED_IN gets written) when the code is pasted or the
// browser comes back to its callback address.
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const done = (how) => {
  writeFileSync(process.env.FAKE_SIGNED_IN, how)
  console.log('Login successful.')
  process.exit(0)
}
if (process.argv.includes('--fail')) {
  console.error('Error: could not reach https://claude.example/oauth?state=secret-state with code ABCD-EFGH12')
  process.exit(3)
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/callback' && url.searchParams.get('code')) { res.end('signed in'); done('callback') }
  else { res.statusCode = 404; res.end() }
})
server.listen(0, '127.0.0.1', () => {
  const callback = `http://localhost:${server.address().port}/callback`
  const auto = `https://claude.example/oauth/authorize?code=true&redirect_uri=${encodeURIComponent(callback)}&state=s1`
  console.log('Opening browser to sign in…')
  execFile(process.env.BROWSER, [auto], () => {
    console.log("If the browser didn't open, visit:")
    console.log('\x1b[94mhttps://claude.example/oauth/authorize?manual=1&state=s1\x1b[0m')
    process.stdout.write('Paste code here if prompted > ')
  })
})
process.stdin.setEncoding('utf8')
process.stdin.on('data', (text) => { if (/^[\w.~-]+#[\w.~-]+$/.test(text.trim())) done('paste') })
