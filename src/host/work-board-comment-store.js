import { randomUUID } from 'node:crypto'
import { commentFileCount, commentFileLimit, commentLength } from '../team/work-board-discussion-format.js'

export const absentComment = () =>
  Object.assign(new Error('评论不存在或无法访问。'), { code: 'bot/not-found' })
export const changedComment = () =>
  Object.assign(new Error('评论已更新，请刷新后再编辑。'), { code: 'bot/stale' })

export function commentBody(body) {
  const value = typeof body === 'string' ? body.replaceAll('\0', '').trim() : ''
  if (value.length > commentLength) throw new Error('评论最多 ' + commentLength + ' 个字符。')
  return value
}

export function commentAuthor(allowed, data) {
  return data.botId ? allowed.get(data.botId)?.name : undefined
}

export function installCommentStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS board_comments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    number INTEGER NOT NULL,
    root_id TEXT NOT NULL,
    parent_id TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_comment_roots ON board_comments(number, seq) WHERE parent_id IS NULL;
  CREATE INDEX IF NOT EXISTS board_comment_thread ON board_comments(number, root_id, seq);
  CREATE TABLE IF NOT EXISTS board_comment_files (
    id TEXT PRIMARY KEY, comment_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_comment_file_owner ON board_comment_files(comment_id);
  CREATE TABLE IF NOT EXISTS board_comment_runs (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL, comment_id TEXT NOT NULL, bot_id TEXT NOT NULL,
    state TEXT NOT NULL, session_id TEXT, turn_id INTEGER, reply_id TEXT, created INTEGER NOT NULL,
    UNIQUE(comment_id, bot_id)
  );
  CREATE INDEX IF NOT EXISTS board_comment_send_queue ON board_comment_runs(created) WHERE state='queued';
  CREATE TABLE IF NOT EXISTS board_comment_routes (
    number INTEGER NOT NULL, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(number, bot_id)
  );
  CREATE TABLE IF NOT EXISTS board_comment_requests (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL, comment_id TEXT NOT NULL, fingerprint TEXT NOT NULL
  );`)
}

const unpack = (row) => row && ({
  ...JSON.parse(row.data),
  id: row.id,
  number: row.number,
  rootId: row.root_id,
  parentId: row.parent_id,
  seq: row.seq,
})

export class BoardCommentStore {
  constructor(db) {
    this.db = db
    this.find = db.prepare('SELECT * FROM board_comments WHERE number=? AND id=?')
    this.files = db.prepare(
      'SELECT id,name,mime,length(bytes) AS size FROM board_comment_files WHERE comment_id=? ORDER BY rowid',
    )
    this.runs = db.prepare(
      'SELECT id,bot_id,state,session_id,turn_id,reply_id FROM board_comment_runs WHERE comment_id=? ORDER BY rowid',
    )
    this.replies = db.prepare('SELECT count(*) AS n FROM board_comments WHERE number=? AND root_id=? AND parent_id IS NOT NULL')
  }

  get(number, id) {
    return unpack(this.find.get(number, String(id ?? '')))
  }

  require(number, id) {
    const entry = this.get(number, id)
    if (!entry) throw absentComment()
    return entry
  }

  insert(number, parent, data) {
    const id = randomUUID()
    const entry = { revision: 1, createdAt: Date.now(), ...data }
    this.db.prepare('INSERT INTO board_comments(id,number,root_id,parent_id,data) VALUES(?,?,?,?,?)')
      .run(id, number, parent?.rootId ?? id, parent?.id ?? null, JSON.stringify(entry))
    if (parent) {
      const root = this.require(number, parent.rootId)
      if (root.resolvedAt) this.update(root, { resolvedAt: null })
    }
    return id
  }

  update(entry, patch) {
    const { id, seq, number, rootId, parentId, ...data } = entry
    this.db.prepare('UPDATE board_comments SET data=? WHERE id=?').run(JSON.stringify({ ...data, ...patch }), id)
  }

  links(entry) {
    const { id, deleted } = entry
    return deleted ? [] : this.files.all(id)
  }

  attach(id, files = [], retain = []) {
    if (!Array.isArray(files) || !Array.isArray(retain) || files.length + retain.length > commentFileCount)
      throw new Error('每条评论最多附加 ' + commentFileCount + ' 个文件。')
    const kept = new Set(retain)
    const saved = this.files.all(id)
    const available = new Set(saved.map(file => file.id))
    if (kept.size !== retain.length || retain.some(file => !available.has(file))) throw absentComment()
    let total = saved.reduce((bytes, file) => bytes + (kept.has(file.id) ? file.size : 0), 0)
    const remove = this.db.prepare('DELETE FROM board_comment_files WHERE id=?')
    for (const file of saved) if (!kept.has(file.id)) remove.run(file.id)
    const insert = this.db.prepare('INSERT INTO board_comment_files VALUES(?,?,?,?,?)')
    for (const file of files) {
      const { name, mime, data } = file ?? {}
      const safeName = typeof name === 'string' ? name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 180) : ''
      if (!safeName || safeName === '.' || safeName === '..' ||
          typeof data !== 'string' || data.length > Math.ceil(commentFileLimit / 3) * 4 ||
          data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('评论附件无效或超过大小限制。')
      const bytes = Buffer.from(data, 'base64')
      total += bytes.length
      if (total > commentFileLimit) throw new Error('单条评论的附件总大小不能超过 2 MB。')
      const safeMime = typeof mime === 'string' && mime.length < 100 && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
        ? mime.toLowerCase() : 'application/octet-stream'
      insert.run(randomUUID(), id, safeName, safeMime, bytes)
    }
  }

  file(number, req, allowed) {
    const entry = this.require(number, req.commentId)
    if (entry.deleted || (entry.botId && !allowed.has(entry.botId))) throw absentComment()
    const file = this.db.prepare('SELECT name,mime,bytes FROM board_comment_files WHERE id=? AND comment_id=?')
      .get(String(req.fileId ?? ''), entry.id)
    if (!file) throw absentComment()
    return { name: file.name, mime: file.mime, size: file.bytes.length, bytes: Buffer.from(file.bytes).toString('base64') }
  }

  project(entry, allowed, { count = false } = {}) {
    const byBot = Boolean(entry.botId)
    const hidden = byBot && !allowed.has(entry.botId)
    const deleted = Boolean(entry.deleted || hidden)
    const parent = entry.parentId && this.get(entry.number, entry.parentId)
    const named = (item) => item?.botId && !allowed.has(item.botId) ? null : commentAuthor(allowed, item ?? {})
    const parentVisible = parent && !parent.deleted && (!parent.botId || allowed.has(parent.botId))
    const runs = deleted ? [] : this.runs.all(entry.id).map(run => {
      const bot = allowed.get(run.bot_id)
      return {
        id: run.id,
        botId: bot?.id ?? null,
        name: bot?.name ?? null,
        state: bot ? run.state : 'unavailable',
        sessionId: bot ? run.session_id : null,
        turnId: bot ? run.turn_id : null,
        replyId: bot ? run.reply_id : null,
      }
    })
    return {
      id: entry.id,
      parentId: entry.parentId,
      rootId: entry.rootId,
      authorType: byBot ? 'bot' : 'person',
      botId: deleted ? null : entry.botId ?? null,
      author: deleted ? null : named(entry) ?? null,
      body: deleted ? '' : entry.body,
      revision: entry.revision,
      createdAt: entry.createdAt,
      editedAt: deleted ? null : entry.editedAt ?? null,
      deleted,
      resolvedAt: entry.parentId ? null : entry.resolvedAt ?? null,
      replyCount: count ? this.replies.get(entry.number, entry.id).n : undefined,
      parent: parent ? {
        author: parentVisible ? named(parent) ?? null : null,
        deleted: !parentVisible,
        excerpt: parentVisible ? parent.body.replace(/\s+/g, ' ').slice(0, 120) : '',
      } : null,
      attachments: deleted ? [] : this.links(entry),
      reactions: deleted ? [] : entry.reactions ?? [],
      mentions: deleted ? [] : (entry.mentions ?? []).filter(id => allowed.has(id)),
      quiet: entry.quiet === true,
      unmatched: !deleted && entry.unmatched === true,
      continuation: deleted || !allowed.has(entry.continuation) ? null : entry.continuation,
      runs,
    }
  }

  list(number, req, allowed) {
    const before = Number.isSafeInteger(req.before) && req.before > 0 ? req.before : Number.MAX_SAFE_INTEGER
    const focus = req.focus ? this.get(number, req.focus) : null
    const root = req.thread ? this.require(number, req.thread) : null
    if (root?.parentId) throw absentComment()
    const limit = root ? 20 : 15
    const rows = root
      ? this.db.prepare(`SELECT * FROM board_comments
          WHERE number=? AND root_id=? AND seq<? AND parent_id IS NOT NULL
          ORDER BY seq DESC LIMIT ?`).all(number, root.id, before, limit + 1)
      : this.db.prepare(`SELECT * FROM board_comments WHERE number=? AND seq<? AND parent_id IS NULL
          ORDER BY seq DESC LIMIT ?`).all(number, before, limit + 1)
    const more = rows.length > limit
    const page = rows.slice(0, limit)
    const next = more ? page.at(-1).seq : null
    const focused = root
      ? focus?.rootId === root.id && focus.parentId ? focus : null
      : focus && this.get(number, focus.rootId)
    if (focused && !page.some(row => row.id === focused.id)) {
      return {
        entries: [
          this.project(focused, allowed, { count: !root }),
          ...page.reverse().map(row => this.project(unpack(row), allowed, { count: !root })),
        ],
        next,
        root: root ? this.project(root, allowed, { count: true }) : null,
        focusThread: focus?.rootId ?? null,
        focusFound: Boolean(focus),
      }
    }
    return {
      entries: page.reverse().map(row => this.project(unpack(row), allowed, { count: !root })),
      next,
      root: root ? this.project(root, allowed, { count: true }) : null,
      focusThread: focus?.rootId ?? null,
      focusFound: Boolean(focus),
    }
  }
}
