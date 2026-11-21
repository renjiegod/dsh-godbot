// Read xterm's active buffer after it applies the CLI's cursor movement and
// erase sequences. Joining soft wraps preserves words that cross a column edge.
export function readNativeScreen(terminal) {
  const buffer = terminal.buffer.active
  const lines = []
  const start = Math.max(0, buffer.length - Math.max(240, terminal.rows))
  for (let y = start; y < buffer.length; y++) {
    const row = buffer.getLine(y)
    if (!row) continue
    const text = row.translateToString(!buffer.getLine(y + 1)?.isWrapped)
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  return lines.join('\n').replace(/^\n+|\n+$/gu, '')
}

// TUIs redraw earlier lines, often around a fixed footer. Diff against the
// screen at submission, never against the previous animation frame.
export function screenSince(before, now, input = '') {
  if (before === now) return ''
  const old = before ? before.split('\n') : [], next = now.split('\n')
  let start = 0, endOld = old.length, endNew = next.length
  while (start < endOld && start < endNew && old[start] === next[start]) start++
  while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) {
    endOld--
    endNew--
  }
  // A scrolling terminal can discard the front of the retained screen.
  // Drop only a matching suffix of old lines at the front of the new output.
  if (!start && endNew) {
    for (let i = Math.max(1, endOld - endNew); i < endOld; i++) {
      const overlap = endOld - i
      if (old[i] === next[0] && old.slice(i, endOld).every((line, j) => line === next[j])) {
        start = overlap
        break
      }
    }
  }
  let output = next.slice(start, endNew).join('\n').replace(/^\n+|\n+$/gu, '')
  // Remove an exact echo of this composer submission. Menu selection arrows
  // and output from other input remain CLI output, regardless of their glyphs.
  if (input) {
    const plain = output.replace(/^\s*[❯›>]\s?/u, '')
    if (plain === input) return ''
    if (plain.startsWith(input + '\n')) output = plain.slice(input.length + 1)
  }
  return output
}
