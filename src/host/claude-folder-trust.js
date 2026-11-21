// Match Claude's ordinary startup dialog on the live PTY screen. The cwd is
// the directory the Host actually launched, never text supplied by the client.
const heading = 'Accessing workspace:'
const question = "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first."
const notice = "Claude Code'll be able to read, edit, and execute files here."
const footer = 'Enter to confirm · Esc to cancel'

function screenLines(screen) {
  const buffer = screen.buffer.active
  const lines = []
  for (let y = buffer.baseY; y < buffer.baseY + screen.rows; y++) {
    const row = buffer.getLine(y)
    if (!row) break
    const wrappedNext = buffer.getLine(y + 1)?.isWrapped
    const text = row.translateToString(!wrappedNext)
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  return lines.map(line => line.trim()).filter(line => line && !/^─+$/u.test(line))
}

function matchesFolder(lines, cwd) {
  // Ink can wrap a long filename itself, or wrap at a space between words.
  // Compare each segment against the launch path without normalizing the path.
  let offset = 0
  for (const line of lines) {
    if (offset && cwd[offset] === ' ' && !cwd.startsWith(line, offset)) offset++
    if (!cwd.startsWith(line, offset)) return false
    offset += line.length
  }
  return offset === cwd.length
}

export function claudeFolderTrustAction(screen, cwd) {
  const lines = screenLines(screen)
  if (!lines.length || (lines[0] !== heading && heading.startsWith(lines[0]))) return null
  if (lines[0] !== heading) return 'stop'
  if (lines.at(-1) !== footer) return null

  const start = lines.findIndex(line => line.startsWith('Quick safety check:'))
  if (start < 2 || !matchesFolder(lines.slice(1, start), cwd)) return 'stop'
  const body = lines.slice(start, -1).join(' ').replace(/\s+/gu, ' ')
  const description = question + ' ' + notice + ' Security guide '
  if (body === description + '❯ No, exit Yes, I trust this folder') return 'select'
  if (body === description + 'No, exit ❯ Yes, I trust this folder') return 'confirm'
  return 'stop'
}
