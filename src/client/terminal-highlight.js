// Semantic highlighting for the native terminal. Like a syntax highlighter for
// terminal output, but applied after xterm renders the CLI's screen: only cells
// the CLI left in the default colors are tinted, through xterm decorations, so
// the PTY byte stream and every color the CLI chose stay exactly as sent.

const extensions = 'js|mjs|cjs|jsx|ts|mts|cts|tsx|json|jsonc|md|mdx|py|pyi|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|swift|' +
  'sh|bash|zsh|fish|ps1|yml|yaml|toml|ini|cfg|conf|env|lock|css|scss|sass|less|html|htm|vue|svelte|astro|sql|graphql|' +
  'gql|proto|txt|log|csv|tsv|xml|svg|gradle|dart|lua|ex|exs|erl|zig|nix|tf|patch|diff|ipynb|png|jpg|jpeg|gif|webp|pdf'
const lineRef = String.raw`(?::\d+(?::\d+)?)?`
const urlRe = /\b(?:https?:\/\/|file:\/\/|www\.)[^\s<>"'`\u3000-\u303f\uff00-\uffef]+/giu
const prose = [
  ['url', urlRe],
  ['code', /`[^`]+`/gu],
  ['string', /"(?:[^"\\]|\\.)+"/gu],
  ['string', /(?<![\p{L}\p{N}_'])'(?:[^'\\]|\\.)+'(?![\p{L}\p{N}_])/gu],
  ['path', new RegExp(String.raw`(?<![\w/.~@-])(?:~|\.{1,2})?(?:/[\w@.+-]+)+/?` + lineRef, 'gu')],
  ['path', new RegExp(String.raw`(?<![\w/.~@-])[\w@.+-]+(?:/[\w@.+-]+)+/?` + lineRef, 'gu'), relativePath],
  ['path', new RegExp(String.raw`(?<![\w/.@-])[\w@+-][\w@.+-]*\.(?:${extensions})` + lineRef + String.raw`(?![\w/-])`, 'giu')],
  ['hash', /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/giu],
  ['hash', /\b(?=[\da-f]*[a-f])(?=[\da-f]*\d)[\da-f]{7,40}\b/gu],
  ['error', /(?<![\w-])(?:[A-Z]\w*(?:Error|Exception)|ERROR|Error|errors?|ERR!?|FAIL(?:ED|URE|S)?|[Ff]ail(?:ed|ure|s)|FATAL|[Ff]atal|[Pp]anic(?:ked)?|PANIC|[Dd]enied|[Rr]efused|Traceback|ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE)(?![\w-])|[✗✘✖❌]|失败|错误|异常|报错/gu],
  ['warn', /(?<![\w-])(?:WARN(?:ING)?S?|[Ww]arn(?:ing|ings)?|[Dd]eprecated|DEPRECATED|[Cc]aution)(?![\w-])|⚠\uFE0F?|警告/gu],
  ['ok', /(?<![\w-])(?:OK|PASS(?:ED)?|[Pp]assed|[Ss]uccess(?:ful(?:ly)?)?|SUCCESS|[Ss]ucceeded|[Cc]ompleted|DONE)(?![\w-])|[✓✔✅]|成功|通过|已完成/gu],
  ['info', /(?<![\w-])(?:INFO|DEBUG|TRACE|NOTE|TODO|FIXME|HINT|TIP)(?![\w-])/gu],
  ['key', /(?<=^\s*(?:[-*+•◦▪‣·]\s+)?)[A-Za-z_][\w.-]{0,39}(?=:(?:\s|$))/gu],
  ['flag', /(?<![\w-])--?[A-Za-z][\w-]*(?:=[^\s,;)]+)?/gu],
  ['number', /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gu],
  ['number', /(?<![\w:.])\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?![\w:])/gu],
  ['number', /(?<![\w.-])v?\d+\.\d+(?:\.\d+)+(?:-[\w.]+)?(?![\w]|\.\d)/gu],
  ['number', /(?<![\w.$#-])(?:0x[\da-fA-F]+|\d+(?:[,_]\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?)(?:%|ms|μs|ns|s|m|h|d|[KMGT]i?B|kB|[kKMBGT]|x|px|em|rem)?(?![\w]|\.\d)/gu],
]
const keywords = new Set(('abstract and as assert async await break case catch chan class const continue crate debugger declare def default ' +
  'defer del delete do done dyn elif else enum esac except export extends extern fi final finally fn for from func function global ' +
  'go goto if impl implements import in instanceof interface is lambda let loop match mod module move mut namespace new nonlocal not ' +
  'of or package pass private protected pub public raise readonly ref return select static struct super switch then throw throws ' +
  'trait try type typeof unsafe use var void where while with yield').split(' '))
const constants = new Set('true false null undefined None True False nil NaN Infinity self this'.split(' '))
const codeStart = /^\s*(?:import\s|export\s|from\s+\S+\s+import\s|(?:const|let|var)\s+[\w${[]|(?:async\s+)?function[\s*(]|def\s+\w|class\s+\w|return\b|if\s*\(|else\b\s*[{:]?|elif\s|for\s*\(|for\s+\w+\s+in\s|while\s*\(|switch\s*\(|case\s.+:|try\s*[{:]|catch\s*\(|except\b|fn\s+\w|pub\s|impl\b|struct\s+\w|enum\s+\w|use\s+[\w:]+|package\s+\w|func\s|interface\s+\w|type\s+\w+\s*=|@\w+|#include|#define|SELECT\s|INSERT\s|UPDATE\s|DELETE\s|CREATE\s)/u
const codeShape = /[;{]\s*$|^\s*[}\])]+[;,)]*\s*$|\)\s*(?:=>|\{)|^\s*[\w.$[\]]+\s*(?:[-+*/]?=|:=)\s*\S/u

function relativePath(text) {
  const plain = text.replace(/:\d+(?::\d+)?$/u, '')
  return /[A-Za-z]/u.test(plain) && (plain.split('/').length > 2 || /\.\w{1,8}$/u.test(plain) || plain !== text)
}

// Remove sentence punctuation and closing brackets that do not belong to the URL.
export function trimUrl(text) {
  let end = text.length, previous
  const count = (char, stop) => { let n = 0; for (let i = 0; i < stop; i++) if (text[i] === char) n++; return n }
  while (end !== previous) {
    previous = end
    while (end && /[.,;:!?'"*_~>]/u.test(text[end - 1])) end--
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']])
      while (text[end - 1] === close && count(close, end) > count(open, end)) end--
  }
  return end
}

// Line-level state that carries across rows: unified diffs and markdown fences.
function fenceOf(text) { return /^\s*(?:```|~~~)/u.test(text) }
function diffHeader(text) {
  return /^(?:diff --git |index [\da-f]{7,}\.\.[\da-f]{7,}|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null))/u.test(text)
}
const hunkRe = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u

export function nextState(text, state = {}) {
  if (fenceOf(text)) return { diff: false, fence: !state.fence }
  if (state.fence) return state
  if (diffHeader(text) || hunkRe.test(text)) return { diff: true, fence: false }
  if (state.diff && /^[-+ \\]/u.test(text)) return state
  return state.diff ? { diff: false, fence: false } : state
}

export function isCodeLine(text) {
  return codeStart.test(text) || codeShape.test(text)
}

// Returns non-overlapping [start, end) tokens for one logical line of output.
export function tokenizeLine(text, state = {}) {
  const tokens = []
  const taken = new Uint8Array(text.length)
  const claim = (start, end, kind) => {
    if (end <= start) return false
    for (let i = start; i < end; i++) if (taken[i]) return false
    taken.fill(1, start, end)
    tokens.push({ start, end, kind })
    return true
  }
  const next = nextState(text, state)
  const done = () => ({ tokens: tokens.sort((a, b) => a.start - b.start), state: next })
  if (fenceOf(text)) {
    claim(0, text.length, 'comment')
    return done()
  }
  if (state.fence) {
    codeTokens(text, claim)
    return done()
  }
  if (diffHeader(text)) {
    claim(0, text.length, 'hunk')
    return done()
  }
  const hunk = hunkRe.exec(text)
  if (hunk) {
    claim(0, hunk[0].length, 'hunk')
    codeTokens(text, claim, hunk[0].length)
    return done()
  }
  if (state.diff && next.diff) {
    const first = text[0]
    if (first === '+') claim(0, text.length, 'added')
    else if (first === '-') claim(0, text.length, 'removed')
    else if (first === '\\') claim(0, text.length, 'comment')
    else codeTokens(text, claim, 1)
    return done()
  }
  const gutter = /^\s*\d+\s?[│|→┃]/u.exec(text)
  if (gutter) {
    claim(0, gutter[0].length, 'comment')
    codeTokens(text, claim, gutter[0].length)
    return done()
  }
  const heading = /^(\s{0,3})#{1,6}\s+\S/u.exec(text)
  if (heading) {
    claim(heading[1].length, text.length, 'heading')
    return done()
  }
  const prompt = /^(\s*)([$%❯›➜»]|>)(?=\s)/u.exec(text)
  if (prompt) {
    const start = prompt[1].length
    claim(start, start + prompt[2].length, 'punct')
    if (prompt[2] === '$' || prompt[2] === '%') {
      const command = /\s+([\w./@+-]+)/uy
      command.lastIndex = start + 1
      const match = command.exec(text)
      if (match) claim(match.index + match[0].length - match[1].length, match.index + match[0].length, 'func')
    }
  } else {
    const bullet = /^(\s*)([-*+•◦▪‣·]|\d{1,3}[.)])(?=\s)/u.exec(text)
    if (bullet) claim(bullet[1].length, bullet[0].length, 'punct')
  }
  if (!prompt && isCodeLine(text)) {
    claimMatches(text, claim, prose.slice(0, 1))
    codeTokens(text, claim)
    return done()
  }
  claimMatches(text, claim, prose)
  return done()
}

function claimMatches(text, claim, rules) {
  for (const [kind, re, accept] of rules) {
    re.lastIndex = 0
    for (let match; (match = re.exec(text));) {
      let end = match.index + match[0].length
      if (kind === 'url') end = match.index + trimUrl(match[0])
      if (!accept || accept(match[0])) claim(match.index, end, kind)
      if (!match[0].length) re.lastIndex++
    }
  }
}

const word = /[@$]?[A-Za-z_$][\w$]*/uy
const number = /(?:0x[\da-f_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[-+]?\d+)?)[a-z]*/iuy
const call = /\s*\(/uy
const identChar = /[\w$]/u

// A small lexer shared by common languages: comments, strings, numbers,
// keywords, calls and type names. It never needs to know the language.
function codeTokens(text, claim, from = 0) {
  const n = text.length
  let i = from
  while (i < n) {
    const c = text[i], prev = i > from ? text[i - 1] : ''
    if (c === '/' && text[i + 1] === '/' && prev !== ':') { claim(i, n, 'comment'); return }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2), end = close < 0 ? n : close + 2
      claim(i, end, 'comment')
      i = end
      continue
    }
    if (c === '#' && (!prev || /\s/u.test(prev)) && !/^#(?:!|\[|include\b|define\b|if|endif\b|pragma\b|import\b)/u.test(text.slice(i, i + 8))) {
      claim(i, n, 'comment')
      return
    }
    if (c === '-' && text[i + 1] === '-' && text[i + 2] === ' ' && (!prev || /\s/u.test(prev))) { claim(i, n, 'comment'); return }
    if (c === '"' || c === '`' || (c === "'" && !/[\p{L}\p{N}_]/u.test(prev))) {
      let j = i + 1
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      const end = Math.min(n, j + 1)
      claim(i, end, 'string')
      i = end
      continue
    }
    if (c >= '0' && c <= '9' && !identChar.test(prev) && prev !== '.') {
      number.lastIndex = i
      const match = number.exec(text)
      claim(i, i + match[0].length, 'number')
      i += match[0].length
      continue
    }
    if (/[A-Za-z_$@]/u.test(c) && !identChar.test(prev)) {
      word.lastIndex = i
      const match = word.exec(text)
      if (!match) { i++; continue }
      const name = match[0], end = i + name.length
      call.lastIndex = end
      const kind = name[0] === '@' ? 'func'
        : keywords.has(name) ? 'keyword'
          : constants.has(name) ? 'number'
            : call.test(text) ? 'func'
              : /^[A-Z][A-Z\d_]{2,}$/u.test(name) ? 'number'
                : /^[A-Z][a-z\d]/u.test(name) ? 'type' : null
      if (kind) claim(i, end, kind)
      i = end
      continue
    }
    i++
  }
}

// Read wrapped rows [start, end) as one string, keeping each code unit's
// buffer row, column and width, and whether the CLI left it unstyled.
export function readLogicalLine(buffer, start, end, cell) {
  let text = ''
  const rows = [], cols = [], widths = [], plain = []
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    // A wrapped row may end in a cell left blank by a wide character that
    // did not fit; the last row drops its unwritten tail.
    const last = visibleCells(line, cell, y + 1 === end)
    for (let x = 0; x < last; x++) {
      const current = line.getCell(x, cell)
      if (!current) break
      const width = current.getWidth()
      if (!width) continue
      const chars = current.getChars() || ' '
      const unstyled = current.isFgDefault() && current.isBgDefault() && !current.isInverse() && !current.isInvisible()
      for (let k = 0; k < chars.length; k++) {
        text += chars[k]
        rows.push(y)
        cols.push(x)
        widths.push(width)
        plain.push(unstyled)
      }
    }
  }
  return { text, rows, cols, widths, plain }
}

function visibleCells(line, cell, last) {
  let x = line.length
  while (x > 0) {
    const current = line.getCell(x - 1, cell)
    if (current && (current.getChars() || (last ? !current.isBgDefault() : current.getWidth() !== 1))) break
    x--
  }
  return x
}

function logicalBounds(buffer, top, bottom) {
  let start = top
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--
  let end = Math.min(bottom, buffer.length)
  while (end < buffer.length && buffer.getLine(end)?.isWrapped) end++
  return [start, end]
}

function nextLogical(buffer, y, end) {
  let stop = y + 1
  while (stop < end && buffer.getLine(stop)?.isWrapped) stop++
  return stop
}

// Group a token's styled code units into per-row decoration runs. A filled
// token (a diff row) also paints the blank cells to the right edge.
function runsOf(line, token, out, fillTo) {
  let run
  for (let i = token.start; i < token.end; i++) {
    if (!line.plain[i]) { run = undefined; continue }
    const y = line.rows[i], x = line.cols[i], w = line.widths[i]
    if (run && run.y === y && run.x + run.w === x) run.w += w
    else if (run && run.y === y && run.x + run.w > x) continue
    else {
      run = { y, x, w, kind: token.kind }
      if (!out.has(y)) out.set(y, [])
      out.get(y).push(run)
    }
  }
  if (fillTo && run && token.end === line.text.length) run.w = Math.max(run.w, fillTo - run.x)
}

const filled = new Set(['added', 'removed'])
const decorationColors = color => typeof color === 'string' ? { foregroundColor: color }
  : { foregroundColor: color.foreground, backgroundColor: color.background }

const contextRows = 160

/** Tint unstyled CLI output in the visible rows. Returns controls to
 * change the palette, switch highlighting on or off, and dispose it. */
export function attachTerminalHighlight(terminal, { colors, enabled = true } = {}) {
  let palette = colors, on = enabled, frame = 0, disposed = false
  const entries = new Map()
  const cell = terminal.buffer.active.getNullCell()

  function drop(entry) {
    if (entry.dropped) return
    entry.dropped = true
    entries.delete(entry.marker)
    for (const decoration of entry.decorations) decoration.dispose()
    entry.marker.dispose()
  }
  function clear() { for (const entry of [...entries.values()]) drop(entry) }
  function schedule() {
    if (on && !disposed && !frame) frame = requestAnimationFrame(scan)
  }
  function stateBefore(buffer, start) {
    let y = Math.max(0, start - contextRows)
    while (y > 0 && buffer.getLine(y)?.isWrapped) y--
    let state = {}
    while (y < start) {
      const stop = nextLogical(buffer, y, start)
      let text = ''
      for (let row = y; row < stop; row++) text += buffer.getLine(row)?.translateToString(row + 1 === stop) ?? ''
      state = nextState(text, state)
      y = stop
    }
    return state
  }
  function scan() {
    frame = 0
    if (!on || disposed) return
    const buffer = terminal.buffer.active
    const top = buffer.viewportY, bottom = Math.min(buffer.length, top + terminal.rows)
    const [start, end] = logicalBounds(buffer, top, bottom)
    const wanted = new Map()
    let state = stateBefore(buffer, start)
    for (let y = start; y < end;) {
      const stop = nextLogical(buffer, y, end)
      const line = readLogicalLine(buffer, y, stop, cell)
      const result = tokenizeLine(line.text, state)
      state = result.state
      for (const token of result.tokens)
        if (palette[token.kind]) runsOf(line, token, wanted, filled.has(token.kind) && terminal.cols)
      y = stop
    }
    const byLine = new Map()
    for (const entry of [...entries.values()]) {
      const line = entry.marker.line
      if (entry.marker.isDisposed || line < top || line >= bottom || byLine.has(line)) drop(entry)
      else byLine.set(line, entry)
    }
    for (let y = top; y < bottom; y++) {
      const runs = wanted.get(y) ?? []
      const signature = runs.map(run => run.x + ':' + run.w + ':' + run.kind).join(',')
      const entry = byLine.get(y)
      if (entry?.signature === signature) continue
      if (entry) drop(entry)
      if (runs.length) decorate(buffer, y, runs, signature)
    }
  }
  function decorate(buffer, y, runs, signature) {
    const marker = terminal.registerMarker(y - buffer.baseY - buffer.cursorY)
    if (!marker) return
    if (marker.line !== y) { marker.dispose(); return }
    const entry = { marker, signature, decorations: [] }
    for (const run of runs) {
      const decoration = terminal.registerDecoration({ marker, x: run.x, width: run.w, ...decorationColors(palette[run.kind]) })
      if (decoration) entry.decorations.push(decoration)
    }
    entries.set(marker, entry)
    marker.onDispose(() => drop(entry))
  }

  const listeners = [
    terminal.onWriteParsed(schedule),
    terminal.onScroll(schedule),
    terminal.onResize(() => { clear(); schedule() }),
    terminal.buffer.onBufferChange(() => { clear(); schedule() }),
  ]
  schedule()
  return {
    setColors(next) {
      palette = next
      clear()
      schedule()
    },
    setEnabled(value) {
      on = !!value
      if (on) schedule()
      else {
        cancelAnimationFrame(frame)
        frame = 0
        clear()
      }
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      for (const listener of listeners) listener.dispose()
      clear()
    },
  }
}

export function linkUrl(text) {
  return /^www\./iu.test(text) ? 'https://' + text : text
}

/** Underline web links on hover. A Cmd or Ctrl click opens them, matching
 * how desktop terminals keep a plain click for focus and selection. */
export function attachTerminalLinks(terminal, { open, hint, plainClick = false }) {
  const cell = terminal.buffer.active.getNullCell()
  return terminal.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const buffer = terminal.buffer.active
      const y = lineNumber - 1
      const [start, end] = logicalBounds(buffer, y, y + 1)
      const line = readLogicalLine(buffer, start, end, cell)
      const links = []
      urlRe.lastIndex = 0
      for (let match; (match = urlRe.exec(line.text));) {
        const last = match.index + trimUrl(match[0]) - 1
        if (/^file:/iu.test(match[0]) || last <= match.index || line.rows[match.index] > y || line.rows[last] < y) continue
        const text = line.text.slice(match.index, last + 1)
        links.push({
          text,
          range: {
            start: { x: line.cols[match.index] + 1, y: line.rows[match.index] + 1 },
            end: { x: line.cols[last] + line.widths[last], y: line.rows[last] + 1 },
          },
          decorations: { pointerCursor: true, underline: true },
          activate(event) { if (plainClick || event.metaKey || event.ctrlKey) open(linkUrl(text)) },
          hover() { hint(true) },
          leave() { hint(false) },
        })
      }
      callback(links.length ? links : undefined)
    },
  })
}
