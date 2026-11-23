// A fake interactive sign-in screen, the way Gemini CLI asks for one in its
// terminal: a link, then a prompt for the authorization code. The typed code
// writes the credential file its sign-in check looks for; the screen stays open,
// as an interactive CLI's does.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
process.stdout.write('Please visit the following URL to authorize the application:\r\n\r\nhttps://accounts.google.example/o/oauth2/auth?state=fixture\r\n\r\nEnter the authorization code: ')
process.stdin.setEncoding('utf8')
let typed = ''
process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      if (typed.trim() === '') continue
      mkdirSync(join(homedir(), '.gemini'), { recursive: true })
      writeFileSync(join(homedir(), '.gemini', 'oauth_creds.json'), '{}')
      process.stdout.write('\r\nSigned in. Press Ctrl+C to leave.\r\n')
      typed = ''
    } else {
      typed += ch
      process.stdout.write(ch)
    }
  }
})
