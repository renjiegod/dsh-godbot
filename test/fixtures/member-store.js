import { randomUUID } from 'node:crypto'
import { Store as WorkspaceStore } from '../../src/host/store.js'

export const collections = ['teams', 'members', 'turns', 'commands', 'events', 'tasks', 'messages', 'interactions']

export class Store extends WorkspaceStore {
  constructor(dir) {
    super(dir)
    this.eventStreamId = randomUUID()
    this.eventTailStatement = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS last FROM records WHERE collection='events'")
    this.eventDeltaStatement = this.db.prepare("SELECT data,seq FROM records WHERE collection='events' AND seq>? ORDER BY seq")
  }
  nativeIdAt(event) {
    if (!event.connectionEpoch) return
    return this.db.prepare(`SELECT json_extract(data, '$.nativeId') AS nativeId FROM records
      WHERE collection='events' AND seq<=? AND json_extract(data, '$.type')='session'
      AND json_extract(data, '$.memberId')=? AND json_extract(data, '$.connectionEpoch')=?
      ORDER BY seq DESC LIMIT 1`).get(event.seq, event.memberId, event.connectionEpoch)?.nativeId
  }
  eventSnapshot(afterEventSeq, streamId) {
    if (afterEventSeq != null && (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0)) {
      throw new Error('afterEventSeq must be a nonnegative safe integer')
    }
    const lastEventSeq = Number(this.eventTailStatement.get().last)
    const sameStream = streamId == null || streamId === this.eventStreamId
    const eventAfter = afterEventSeq != null && sameStream && afterEventSeq <= lastEventSeq ? afterEventSeq : null
    const events = this.eventDeltaStatement.all(eventAfter ?? 0).map(row => this.decode(row))
    return { events, lastEventSeq, eventAfter, eventStreamId: this.eventStreamId }
  }
}
