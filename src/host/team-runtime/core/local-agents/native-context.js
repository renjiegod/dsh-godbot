// What DSH adds to a conversation for its own agent that a local agent CLI has
// its own of. The skill catalog lists DSH skills, loaded with a DSH tool the CLI
// is not given; the CLI lists its own skills. Workspace instructions repeat the
// instruction files the CLI reads by itself from its working folder: Claude Code
// its CLAUDE.md files, Codex its AGENTS.md files. The files no CLI reads, such
// as the user-wide ~/.agents/AGENTS.md, stay in the conversation.
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { textOf } from '../text.js'

const SKILL_CATALOG = 'skill-catalog'
const AGENT_INSTRUCTIONS = 'agent-instructions'
const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'
// The headings DSH opens each instruction file's part with.
const SECTION = /^(?:Instructions from|Additional instructions from|Updated instructions from|Instructions removed): (.+)$/
// DSH shows a CLAUDE.md whose text is the same as the AGENTS.md beside it only
// once, under the AGENTS.md (a CLAUDE.md that links to AGENTS.md, for one).
const CLAUDE_TWIN = { 'AGENTS.md': 'CLAUDE.md', 'AGENTS.local.md': 'CLAUDE.local.md' }

// The conversation as the CLI should read it. `sandboxed` CLIs see only their
// own workspace, not the folders above it, so their instructions all stay.
export function withoutNativeContext(messages, { kind, cwd, sandboxed = false } = {}) {
  const list = messages ?? []
  if (!list.some(message => isKind(message, SKILL_CATALOG) || isKind(message, AGENT_INSTRUCTIONS))) return list
  const native = sandboxed || typeof cwd !== 'string' || cwd === '' ? undefined : nativeReader(kind, cwd)
  const out = []
  for (const message of list) {
    if (isKind(message, SKILL_CATALOG)) continue
    if (isKind(message, AGENT_INSTRUCTIONS) && native !== undefined) {
      const kept = withoutNativeFiles(message, native)
      if (kept !== undefined) out.push(kept)
      continue
    }
    out.push(message)
  }
  return out
}

const isKind = (message, kind) => message?.role === 'user' && message.source?.kind === kind

// The message without the parts for files the CLI reads itself; undefined when
// nothing else is left of it. A message whose layout is not the one known here
// stays whole.
function withoutNativeFiles(message, isNative) {
  const text = textOf(message.content)
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return message
  const body = text.slice(OPEN.length, -CLOSE.length).trim()
  const blocks = body.split('\n\n')
  const lead = []
  const sections = []
  for (const block of blocks) {
    // A file that ends with a line break leaves a blank line before the next
    // file's heading.
    const heading = SECTION.exec(block.replace(/^\n+/, '').split('\n', 1)[0])
    if (heading !== null) sections.push({ path: heading[1].trim(), blocks: [block] })
    else if (sections.length === 0) lead.push(block)
    else sections.at(-1).blocks.push(block)
  }
  if (sections.length === 0) return message
  const kept = sections.filter(section => !isNative(section.path))
  if (kept.length === sections.length) return message
  if (kept.length === 0) return undefined
  const rest = [...lead, ...kept.flatMap(section => section.blocks)].join('\n\n')
  return { ...message, content: [{ type: 'text', text: `${OPEN}\n${rest}\n${CLOSE}` }] }
}

// Whether the CLI reads a file DSH showed by itself. DSH shows a project file by
// its path from the project root (the nearest folder with .git, else the
// working folder) and a user-wide one from ~ or an environment variable.
function nativeReader(kind, cwd) {
  if (kind !== 'claude' && kind !== 'codex') return undefined
  const root = projectRoot(cwd)
  return (path) => {
    if (path.startsWith('~') || path.startsWith('$') || isAbsolute(path)) return false
    const file = resolve(root, path)
    const name = basename(file)
    const dir = dirname(file)
    if (kind === 'codex') {
      // An AGENTS.override.md takes the place of the AGENTS.md beside it in Codex.
      return name === 'AGENTS.md' && !existsSync(join(dir, 'AGENTS.override.md'))
    }
    if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') return true
    const twin = CLAUDE_TWIN[name]
    return twin !== undefined && sameText(file, join(dir, twin))
  }
}

function projectRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

function sameText(a, b) {
  try {
    return readFileSync(a, 'utf8').trim() === readFileSync(b, 'utf8').trim()
  } catch {
    return false
  }
}
