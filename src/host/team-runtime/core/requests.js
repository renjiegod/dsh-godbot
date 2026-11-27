// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Request identities: a request a Bot names itself is sent once, however often it repeats it.
//
// message_bot merges what the recipient has not read yet, but a request that was read and
// whose answer was lost could be sent again, and the work would be done twice. A caller
// that names its request (`request_id`) gets that guarantee: the name belongs to the
// caller and to the conversation the request was made from, what the request stands for
// is remembered with a fingerprint of what was asked, and the existing receipt
// is read back instead of a second delivery. The receipt is written before the message
// goes out, so a restart cannot turn a lost answer into a second delivery either; when
// the outcome of an admission is not known, the request is not sent again.
//
// Accepted identities stay with the team: expiring one would permit an old retry to
// repeat side effects. Removing receipts needs a separate, explicit retention policy.
import { createHash } from 'node:crypto'

// A request name this long is a mistake, not an identity.
export const NAME_MAX = 200

export function install(rt) {
  const { state } = rt
  const receipts = () => (state.requests ??= {})
  // Requests being admitted now, so that two at once admit one.
  const inflight = new Map()

  // What the request asked for, as a short hash: the same name with the same content is
  // the same request, and the same name with other content is a mistake.
  const print = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  // The name of a request in the caller's own space: its Bot, the conversation the request
  // was made from, and the name the caller gave it. The Bot, not its Session: a Bot that
  // moves to a fresh part of its conversation keeps its name.
  const identity = ({ caller, context, name, payload }) => ({
    key: `${caller}\u0000${context}\u0000${name}`,
    print: print(payload),
  })

  // What a request that was admitted before means for the caller now: its receipt, a
  // conflict, or an outcome that is not known. Undefined when it was never admitted.
  const verdict = (request, record) => {
    if (record.fingerprint !== request.print) return { status: 'conflict' }
    if (record.deliveryId !== undefined && rt.inboxHas?.(record.deliveryId)) {
      // The association and admission share one state.json write. It also
      // recovers a receipt when the sender's original call never returned.
      return { status: 'replay', receipt: rt.inboxReceipt(record.deliveryId, record.deliveryReceipt) }
    }
    if (record.outcome === 'delivered') {
      // The receipt is gone, but the name stays taken: it is not used again by accident.
      return record.receipt === undefined ? { status: 'expired' } : { status: 'replay', receipt: record.receipt }
    }
    if (record.outcome === 'uncertain') return { status: 'uncertain' }
    // Admitted, not settled: the call is still going, or it was cut short.
    return undefined
  }

  // What is known about a request that was admitted before. Undefined when the request
  // was never admitted.
  const known = async (request) => {
    const before = rt.own(receipts(), request.key)
    if (before === undefined) return
    if (before.fingerprint !== request.print) return { status: 'conflict' }
    await inflight.get(request.key)?.catch(() => {})
    const record = rt.own(receipts(), request.key)
    if (record === undefined) return
    return verdict(request, record) ?? { status: 'uncertain' }
  }

  // Test and reserve the identity without yielding so concurrent calls admit once.
  const admit = async (request, work) => {
    if (rt.own(receipts(), request.key) !== undefined) {
      const seen = await known(request)
      return seen ?? admit(request, work)
    }
    // A receipt that cannot be saved cannot stop a second delivery later.
    if (rt.readOnly() !== undefined) return { status: 'readonly' }
    const fresh = { fingerprint: request.print, outcome: 'pending', at: Date.now() }
    receipts()[request.key] = fresh
    const promise = (async () => {
      try {
        // Ordinary saves may be skipped when this host closes or loses the lock.
        await rt.save({ required: true })
      } catch (error) {
        delete receipts()[request.key]
        rt.warn('godbot: the receipt of the request was not saved: %s', error)
        throw error
      }
      try {
        const receipt = await work()
        if (request.unsent === true) {
          // The work decided before anything went out: it is not a delivered
          // receipt, so the request is free to be admitted again. The removal has
          // to be saved before that is true: a leftover pending record stays.
          delete receipts()[request.key]
          try {
            await rt.save({ required: true })
          } catch (error) {
            fresh.outcome = 'uncertain'
            fresh.at = Date.now()
            receipts()[request.key] = fresh
            rt.warn('godbot: the removal of the request receipt was not saved: %s', error)
          }
          return receipt
        }
        fresh.outcome = 'delivered'
        fresh.receipt = receipt
        fresh.at = Date.now()
        await rt.save().catch(() => {})
        return receipt
      } catch (error) {
        // The message may have gone out; it is not sent again.
        fresh.outcome = 'uncertain'
        fresh.at = Date.now()
        await rt.save().catch(() => {})
        throw error
      }
    })()
    inflight.set(request.key, promise)
    try {
      return { status: 'sent', receipt: await promise }
    } finally {
      inflight.delete(request.key)
    }
  }

  const bindInboxRequest = (request, id, receipt) => {
    if (!request) return
    const record = rt.own(receipts(), request.key)
    if (!record) return
    record.deliveryId = id
    record.deliveryReceipt = receipt
    return () => { delete record.deliveryId; delete record.deliveryReceipt }
  }

  Object.assign(rt, { requestIdentity: identity, knownRequest: known, admitRequest: admit, bindInboxRequest })
}
