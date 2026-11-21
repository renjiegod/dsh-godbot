import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// Installed only inside the candidate Host for crash tests. Stop at the exact commit
// containing the chosen delivery, before the HTTP handler can acknowledge it.
const original = DatabaseSync.prototype.exec
const marker = process.env.GODBOT_E2E_COMMIT_GATE
if (marker)
  DatabaseSync.prototype.exec = function exec(sql) {
    if (sql !== 'COMMIT' || !existsSync(marker)) return original.call(this, sql)
    const { phase, requestId } = JSON.parse(readFileSync(marker, 'utf8'))
    let row
    try {
      row = this.prepare(
        "SELECT id FROM records WHERE collection='automationRequests' AND json_extract(id, '$[1]')=?",
      ).get(requestId)
    } catch {
      /* Other SQLite connections in this Host have unrelated schemas. */
    }
    if (!row) return original.call(this, sql)
    if (phase === 'after') original.call(this, sql)
    unlinkSync(marker)
    writeFileSync(marker + '.observed', phase)
    process.kill(process.pid, 'SIGKILL')
  }
