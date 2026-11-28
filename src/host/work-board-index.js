import { boardSortField, priorityRank } from '../team/work-board-planning.js'

const priority = `COALESCE(json_extract(meta,'$.priority'),0)`
const rank = `CASE ${priority} ${priorityRank.map((value, id) => `WHEN ${id} THEN ${value}`).join(' ')} ELSE 0 END`
// Durable identities and a rebuildable projection. The dirty queue participates in the
// source writer's transaction, including writes outside the board (workflows, CI and tools).
const sourceKeys = {
  tasks: ['task', 'ROW.id'],
  messages: ['task', "json_extract(ROW.data,'$.taskId')"],
  botTaskDeliveries: ['task', "json_extract(ROW.data,'$.taskId')"],
  automationRuns: ['run', "CASE WHEN json_extract(ROW.data,'$.targetId') IS NOT NULL THEN ROW.id END"],
  fullTeamTasks: ['run', "json_extract(ROW.data,'$.runId')"],
  fullTeamEvidence: ['run', "json_extract(ROW.data,'$.runId')"],
}
export const affectsBoard = (collection) => Object.hasOwn(sourceKeys, collection)
export const boardPhases = ['todo', 'doing', 'attention', 'review', 'done', 'history']
export const cardId = (number) => 'GB-' + number
export const millis = (value) => (typeof value === 'number' ? value : Date.parse(value) || 0)

export function installBoardIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS board_cards (
    number INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL, origin_key TEXT UNIQUE, meta TEXT NOT NULL DEFAULT '{}', summary TEXT,
    UNIQUE(kind,scope,source_id));
    CREATE INDEX IF NOT EXISTS board_order ON board_cards(json_extract(summary,'$.phase'),
      json_extract(meta,'$.priority') DESC,json_extract(summary,'$.updated') DESC,number DESC);
    CREATE INDEX IF NOT EXISTS board_order_v2 ON board_cards(json_extract(summary,'$.phase'),
      ${rank} DESC,json_extract(summary,'$.updated') DESC,number DESC);
    CREATE INDEX IF NOT EXISTS board_messages ON records(json_extract(data,'$.taskId'),seq) WHERE collection='messages';
    CREATE TABLE IF NOT EXISTS board_dirty(kind TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(kind,source_id));
    CREATE TABLE IF NOT EXISTS board_requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,number INTEGER NOT NULL,outcome TEXT);
    CREATE TABLE IF NOT EXISTS board_version(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
  `)
  for (const [op, row] of [
    ['INSERT', 'NEW'],
    ['UPDATE', 'NEW'],
    ['DELETE', 'OLD'],
  ]) {
    // One trigger per operation. Unrelated records short-circuit before reading JSON.
    const cases = Object.entries(sourceKeys)
      .map(
        ([name, [kind, id]]) =>
          `INSERT INTO board_dirty SELECT '${kind}', ${id.replaceAll('ROW', row)}
       WHERE ${row}.collection='${name}' AND (${id.replaceAll('ROW', row)}) IS NOT NULL
       ON CONFLICT(kind,source_id) DO NOTHING;`,
      )
      .join('\n')
    const names = Object.keys(sourceKeys)
      .map((key) => "'" + key + "'")
      .join(',')
    db.exec(`CREATE TRIGGER IF NOT EXISTS work_board_${op} AFTER ${op} ON records
      WHEN ${row}.collection IN (${names}) BEGIN ${cases} END`)
  }
  if (!db.prepare('SELECT 1 FROM board_version WHERE id=1').get()) {
    db.exec(`BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO board_dirty SELECT 'task',id FROM records WHERE collection='tasks';
      INSERT OR IGNORE INTO board_dirty SELECT 'run',id FROM records WHERE collection='automationRuns' AND json_extract(data,'$.targetId') IS NOT NULL;
      INSERT INTO board_version VALUES(1,1); COMMIT`)
  }
}

export function accessOf(rt) {
  const bots = Object.values(rt.state.bots ?? {}).filter((b) => !b.private)
  const ids = new Set(bots.map((b) => b.id))
  const rooms = Object.values(rt.state.rooms ?? {}).filter(
    (r) => !r.private && r.members.every((id) => ids.has(id)),
  )
  const allowed = new Set([...bots.map((b) => 'bot/' + b.id), ...rooms.map((r) => 'room/' + r.id)])
  return { bots, rooms, allowed }
}

export function queryBoard(db, access, req, readOnly) {
  const allowedRefs = JSON.stringify([...access.allowed])
  const values = [allowedRefs]
  const predicates = [
    'summary IS NOT NULL',
    "NOT EXISTS (SELECT 1 FROM json_each(summary,'$.refs') WHERE value NOT IN (SELECT value FROM json_each(?)))",
  ]
  const field = (name) => "json_extract(summary,'$." + name + "')"
  for (const [key, col] of [
    ['owner', 'owner'],
    ['room', 'room'],
    ['source', 'source'],
  ]) {
    if (req[key]) {
      predicates.push('COALESCE(' + field(col) + ",'')=?")
      values.push(key === 'owner' && req[key] === 'unassigned' ? '' : String(req[key]))
    }
  }
  if (req.section) {
    const ids = [...access.bots, ...access.rooms].filter((r) => r.sectionId === req.section).map((r) => r.id)
    predicates.push(
      '(' +
        field('owner') +
        ' IN (SELECT value FROM json_each(?)) OR ' +
        field('room') +
        ' IN (SELECT value FROM json_each(?)))',
    )
    values.push(JSON.stringify(ids), JSON.stringify(ids))
  }
  for (const key of ['assignee', 'statusId', 'startBefore', 'dueBefore', 'label']) {
    if (!req[key]) continue
    if (key === 'label') predicates.push("EXISTS (SELECT 1 FROM json_each(meta,'$.labels') WHERE value=?)")
    else if (key.endsWith('Before')) {
      const column = key === 'startBefore' ? 'startDate' : 'dueDate'
      predicates.push(field(column) + "<>'' AND " + field(column) + "<=?")
    } else if (key === 'assignee')
      predicates.push("COALESCE(NULLIF(" + field('assignee') + ",''),'bot/'||" + field('owner') + ",'')=?")
    else predicates.push(field(key) + "=?")
    values.push(key === 'assignee' && req[key] === 'unassigned' ? '' : String(req[key]))
  }
  if (/^[0-4]$/.test(req.priority ?? '')) {
    predicates.push(priority + '=?')
    values.push(Number(req.priority))
  }
  if (/^[\w-]{1,64}$/.test(req.property ?? '') && req.propertyValue != null && req.propertyValue !== '') {
    predicates.push("EXISTS (SELECT 1 FROM json_each(meta,?) WHERE lower(CASE WHEN type IN ('true','false') THEN type ELSE CAST(value AS TEXT) END)=lower(?))")
    values.push('$.customValues.' + req.property, String(req.propertyValue).slice(0, 250))
  }
  const search = String(req.search ?? '').trim().slice(0, 160)
  if (search) {
    const discussions = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='board_comments'").get()
    const roomBots = Object.fromEntries(access.rooms.map(room => [room.id, room.members]))
    const allowed = JSON.stringify({ all: access.bots.map(bot => bot.id), rooms: roomBots })
    const comment = discussions ? `OR EXISTS (
      SELECT 1 FROM board_comments AS c WHERE c.number=board_cards.number
      AND COALESCE(json_extract(c.data,'$.deleted'),0)=0
      AND (json_extract(c.data,'$.botId') IS NULL OR json_extract(c.data,'$.botId') IN (
        SELECT value FROM json_each(CASE WHEN json_extract(board_cards.summary,'$.room') IS NULL
          THEN json_extract(?,'$.all') ELSE (
            SELECT value FROM json_each(?,'$.rooms') WHERE key=json_extract(board_cards.summary,'$.room')
          ) END)
      ))
      AND instr(lower(json_extract(c.data,'$.body')),lower(?))>0
    )` : ''
    for (const term of search.split(/\s+/).slice(0, 10)) {
      predicates.push(`(instr(lower(${field('title')}),lower(?))>0 OR instr('GB-'||number,upper(?))>0
        OR instr(lower(COALESCE(json_extract(meta,'$.description'),'')),lower(?))>0
        OR instr(lower(COALESCE(json_extract(meta,'$.criteria'),'')),lower(?))>0
        ${comment})`)
      values.push(term, term, term, term)
      if (discussions) values.push(allowed, allowed, term)
    }
  }
  const where = predicates.join(' AND ')
  const phase = field('phase'), mine = field('needs'), updated = field('updated')
  const sort = boardSortField(req.sort)
  const dateKey = key => `COALESCE(-CAST(replace(NULLIF(${field(key)},''),'-','') AS INTEGER),-99999999)`
  let sortKey = rank
  if (sort === 'updated') sortKey = updated
  if (sort === 'startDate' || sort === 'dueDate') sortKey = dateKey(sort)
  if (sort === 'title') sortKey = `lower(${field('title')})`
  if (sort?.startsWith('property/')) {
    const value = `json_extract(meta,'$.customValues.${sort.slice(9)}')`
    sortKey = `COALESCE(CASE WHEN typeof(${value})='text' THEN -CAST(replace(${value},'-','') AS INTEGER)
      ELSE ${value} END,-1e100)`
  }
  const forward = sort === 'title'
  const direction = forward ? 'ASC' : 'DESC'
  const totals = db
    .prepare(
      `SELECT ${phase} AS phase,count(*) AS n,sum(${mine}) AS mine FROM board_cards WHERE ${where} GROUP BY ${phase}`,
    )
    .all(...values)
  const counts = { all: 0, mine: 0, history: 0 }
  for (const t of totals) {
    if (t.phase === 'history') counts.history += t.n
    else {
      counts.all += t.n
      counts.mine += Number(t.mine)
    }
  }
  const phases = req.phase
    ? [req.phase].filter((p) => boardPhases.includes(p))
    : req.tab === 'history'
      ? ['history']
      : boardPhases.slice(0, -1)
  const limit = Math.max(1, Math.min(100, Math.floor(Number(req.limit) || 30)))
  const visibleParent = db.prepare(`SELECT 1 FROM board_cards WHERE number=? AND summary IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(summary,'$.refs') WHERE value NOT IN (SELECT value FROM json_each(?)))`)
  const columns = phases.map((p) => {
    const after = req.after?.[p]
    const params = [...values, p]
    let condition = where + ' AND ' + phase + '=?'
    if (req.tab === 'mine') condition += ' AND ' + mine + '=1'
    if (after) {
      if (!Array.isArray(after) || after.length !== 3 ||
        !(forward ? typeof after[0] === 'string' : Number.isFinite(after[0])) ||
        !after.slice(1).every(Number.isSafeInteger))
        throw new Error('Invalid board cursor')
      condition += forward
        ? ` AND (${sortKey} > ? OR (${sortKey} = ? AND (${updated},number)<(?,?)))`
        : ` AND (${sortKey},${updated},number)<(?,?,?)`
      params.push(...(forward ? [after[0], ...after] : after))
    }
    const rows = db
      .prepare(
        `SELECT number,meta,summary,${priority} AS priority,${sortKey} AS sort_key FROM board_cards WHERE ${condition}
      ORDER BY ${sortKey} ${direction},${updated} DESC,number DESC LIMIT ?`,
      )
      .all(...params, limit + 1)
    const items = rows.slice(0, limit).map(row => {
      const card = publicCard(row)
      if (card.parent && !visibleParent.get(Number(card.parent.slice(3)), allowedRefs)) delete card.parent
      return card
    })
    const last = rows[limit - 1]
    const total = totals.find((t) => t.phase === p)
    return {
      phase: p,
      total: Number((req.tab === 'mine' ? total?.mine : total?.n) ?? 0),
      items,
      next: rows.length > limit ? [last.sort_key, JSON.parse(last.summary).updated, last.number] : null,
    }
  })
  return {
    columns,
    counts,
    readOnly,
    revision: db.prepare('SELECT revision FROM board_version WHERE id=1').get().revision,
    bots: access.bots.map(({ id, name }) => ({ id, name })),
    rooms: access.rooms.map(({ id, name }) => ({ id, name })),
  }
}

export function publicCard(row) {
  const { refs, ...summary } = JSON.parse(row.summary)
  return {
    ...summary,
    id: cardId(row.number),
    number: row.number,
    priority: row.priority ?? JSON.parse(row.meta).priority ?? 0,
  }
}
