// DSH's persisted turn reason is the source of the conversation's verdict.
export const NATIVE_INTERRUPTED = 'LOCAL_AGENT_INTERRUPTED'

export function turnOutcome(reason) {
  switch (reason?.kind) {
    case 'aborted': {
      const cause = reason.reason?.kind === 'hook' ? reason.reason.reason : reason.reason?.kind
      if (cause === 'user' || cause === 'godbot/stopped' || cause === 'ds-bot/stopped') return { status: 'stopped', cause }
      if (cause === 'godbot/steer' || cause === 'ds-bot/steer') return { status: 'interrupted', cause: 'steered' }
      return { status: 'interrupted', cause }
    }
    case 'interrupted': return { status: 'interrupted', cause: 'host-interrupted' }
    case 'max-tokens': return { status: 'interrupted', cause: 'output-limit' }
    case 'error':
    case 'failed': {
      const code = reason.error?.code
      if (code === NATIVE_INTERRUPTED || code === 'LOCAL_AGENT_EXIT' || code === 'INTERRUPTED')
        return { status: 'interrupted', cause: 'agent-interrupted', code }
      return { status: 'failed', code }
    }
    case 'completed': return { status: 'completed' }
  }
}
