// Carried only on the in-process request, never in a Session event or on the wire.
export const INBOX_DELIVERY = Symbol('godbot inbox delivery')

// Codex records the exact user input in its native thread. This marker correlates
// it with the host inbox when the transport cannot tell us whether it accepted.
export const inboxMarker = id => `[Godbot message ID: ${id}]`
