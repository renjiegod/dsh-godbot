// The installed browser opens this interactive process through DSH's actual PTY.
import { writeFileSync } from 'node:fs'
import { emitKeypressEvents } from 'node:readline'

export function runClaudeTerminal(receipt) {
  const cwd = process.cwd()
  const nativeId = process.argv[process.argv.indexOf('--resume') + 1]
  const keys = []
  let selected = false, accepted = false, input = ''
  function paint() {
    process.stdout.write('\x1b[2J\x1b[H' + [
      'Accessing workspace:', '', cwd, '',
      "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
      '', "Claude Code'll be able to read, edit, and execute files here.", '', 'Security guide', '',
      (selected ? '  ' : '❯ ') + 'No, exit', (selected ? '❯ ' : '  ') + 'Yes, I trust this folder', '',
      'Enter to confirm · Esc to cancel',
    ].join('\r\n'))
  }
  process.stdin.setRawMode(true)
  emitKeypressEvents(process.stdin)
  process.stdin.on('keypress', (text, key) => {
    keys.push(key.name)
    if (!accepted && key.name === 'down') { selected = true; paint() }
    else if (!accepted && selected && key.name === 'return') {
      accepted = true
      process.stdout.write('\x1b[2J\x1b[HNative folder accepted\r\n')
    } else if (accepted && key.name === 'return') {
      process.stdout.write('Fixture reply: ' + input + '\r\n')
      input = ''
    } else if (accepted && text) {
      input += text
    }
    writeFileSync(receipt, JSON.stringify({ cwd, nativeId, keys, accepted }))
  })
  process.stdin.resume()
  paint()
}
