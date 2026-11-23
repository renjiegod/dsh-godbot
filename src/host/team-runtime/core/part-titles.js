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

// The first prompt in DSH's turn outline: its turn's start, and the outline's own
// preview of it, which ends in "…" when cut. The outline's wire value is the entry
// list; its stored state wraps that list in `turns`.
export function firstPrompt(outline) {
  const turns = Array.isArray(outline) ? outline : Array.isArray(outline?.turns) ? outline.turns : []
  const entry = turns.find(turn => typeof turn?.prompt === 'string' && turn.prompt.trim() !== '')
  if (entry === undefined) return undefined
  return { seq: Number.isInteger(entry.seq) ? entry.seq : undefined, preview: entry.prompt.replace(/…$/u, '') }
}
