// The name a Bot's chat session goes by in the session list: the first thing the user
// asked in it, on one line. A link reads as the last two parts of its path
// ("issues/2020"), so sessions that start with a pasted address still tell apart.
export const TITLE_MAX = 80

// A web address as people paste it: ASCII up to the first space or CJK text. The
// punctuation that ends a sentence around it is not part of it.
const LINK = /\bhttps?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/giu
const LINK_TAIL = /[.,;:!?'")\]]+$/u

const decoded = (text) => {
  try { return decodeURIComponent(text) } catch { return text }
}

export function shortLink(link) {
  let url
  try { url = new URL(link) } catch { return link }
  // GitLab puts a lone "-" between a project and its pages.
  const path = url.pathname.split('/').filter(part => part !== '' && part !== '-')
  if (path.length === 0) return url.hostname.replace(/^www\./u, '')
  return decoded(path.slice(-2).join('/'))
}

export function partTitle(text) {
  const line = String(text ?? '')
    .replace(LINK, (link) => {
      const tail = link.match(LINK_TAIL)?.[0] ?? ''
      return shortLink(link.slice(0, link.length - tail.length)) + tail
    })
    .replace(/\s+/gu, ' ')
    .trim()
  const chars = [...line]
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('').trimEnd()}…` : line
}

// A Bot's request names the conversation it opens by the title its sender gave it, or
// else by its headline. Bots write long, formal requests whose first sentence says
// what the work is: the headline is the first line, up to the end of its first
// sentence, or up to a colon or bar that ends a label ("Release 0.2.31: …"). A cut
// never falls inside brackets or quotes, and a short opening ("Hi.", "发版请求：")
// runs on to the next cut. A line that opens with a bracketed name ("【Release
// coordination】…") is named by it, and a task named as one ("任务「…」", "Task: …")
// by the name alone.
const SENTENCE_MIN = 4
const LABEL_MIN = 10
const OPENERS = '「『“‘（([【《〈'
const CLOSERS = '」』”’）)]】》〉'
const SENTENCE_ENDS = '。！？'
const LABEL_ENDS = '：｜'
const LEAD_NAME = /^[【[]([^【】[\]]{2,})[】\]]/u
// Markdown a Bot may open a line with: a heading, quote or list mark, then a space.
// "#2094" is an issue, not a heading.
const LINE_MARKS = /^\s*(?:(?:#{1,6}|[>*•·-])\s+)+/u
const TASK_NAME = /^(?:任务|Task)\s*(?:[:：]\s*(.+)|「([^」]+)」|“([^”]+)”|"([^"]+)")$/iu

const lengthOf = text => [...text].length

function taskName(head) {
  const named = TASK_NAME.exec(head)
  return named === null ? head : (named[1] ?? named[2] ?? named[3] ?? named[4]).trim()
}

function headline(text) {
  const line = String(text ?? '').split('\n')
    .map(row => row.replace(/\*\*|__|`/gu, '').replace(LINE_MARKS, '').trim())
    .find(row => row !== '') ?? ''
  const lead = LEAD_NAME.exec(line)
  if (lead) return lead[1].trim()
  const chars = [...line]
  let depth = 0
  for (let at = 0; at < chars.length; at += 1) {
    const char = chars[at]
    if (OPENERS.includes(char)) depth += 1
    else if (CLOSERS.includes(char) && depth > 0) depth -= 1
    if (depth > 0) continue
    // ASCII marks end a sentence or a label only before a space: "v0.2.31", "!157",
    // "https://" and "09:20" go on.
    const spaced = at + 1 === chars.length || /\s/u.test(chars[at + 1])
    const sentence = SENTENCE_ENDS.includes(char) || ('.!?'.includes(char) && spaced)
    const label = LABEL_ENDS.includes(char) || (':|'.includes(char) && spaced)
    if (!sentence && !label) continue
    const head = chars.slice(0, at).join('').trim()
    if (lengthOf(head) >= (sentence ? SENTENCE_MIN : LABEL_MIN)) return taskName(head)
  }
  return taskName(line.replace(/[\s，,、：:；;。．.!！?？]+$/u, ''))
}

export function requestTitle(text, given) {
  const named = partTitle(given)
  return named !== '' ? named : partTitle(headline(text))
}

// The first prompt in DSH's turn outline: its turn's start, and the outline's own
// preview of it, which ends in "…" when cut. The outline's wire value is the entry
// list; its stored state wraps that list in `turns`.
export function firstPrompt(outline) {
  const turns = Array.isArray(outline) ? outline : Array.isArray(outline?.turns) ? outline.turns : []
  const entry = turns.find(turn => typeof turn?.prompt === 'string' && turn.prompt.trim() !== '')
  if (entry === undefined) return undefined
  return { seq: Number.isInteger(entry.seq) ? entry.seq : undefined, preview: entry.prompt.replace(/…$/u, '') }
}
