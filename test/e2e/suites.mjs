// The scenarios each e2e suite runs (scripts/e2e.mjs). A release candidate must
// pass the whole release suite: scripts/release-candidate.mjs checks a report
// against this list before it vouches for the archive.
export const release = [
  'WORK-BOARD',
  'WORKSPACE-CAPABILITIES', 'BOT-MANAGEMENT', 'BOT-FAILOVER-SECTIONS', 'COMMAND-QUIET', 'NEW-SESSION', 'DRAFT-ATTACHMENTS',
  'BACKGROUND-REPLY', 'BOT-MESSAGE-ROUTING', 'BOT-HANDOFF-ROUTING', 'CONVERSATION-TOOLS', 'E0', 'E1', 'E2', 'E4', 'E4-FULL', 'E5',
  'E8', 'E12', 'UPGRADE-PREVIOUS', 'E13', 'E15', 'E16', 'E17', 'LOCAL-SIGNIN', 'UPDATE', 'PHONE', 'PHONE-PAGES', 'REMOTE-COMPUTERS',
  'BUNDLED-COMPUTER-HOST', 'TURN-OUTCOMES', 'NEW-SESSION-HANDOFF', 'BOT-GOALS', 'AGENT-MODEL-OPTIONS',
]

export const all = [
  'WORK-BOARD-SCALE',
  'WORK-BOARD',
  'WORKSPACE-CAPABILITIES', 'BOT-MANAGEMENT', 'BOT-FAILOVER-SECTIONS', 'COMMAND-QUIET', 'NEW-SESSION', 'DRAFT-ATTACHMENTS',
  'BACKGROUND-REPLY', 'BOT-MESSAGE-ROUTING', 'BOT-HANDOFF-ROUTING', 'CONVERSATION-TOOLS', 'LOCAL-SIGNIN',
  ...Array.from({ length: 18 }, (_, i) => 'E' + i).filter(id => id !== 'E3').flatMap(id => id === 'E4' ? [id, 'E4-FULL'] : [id]),
  'UPGRADE-PREVIOUS', 'UPDATE', 'PHONE', 'PHONE-PAGES', 'REMOTE-COMPUTERS', 'BUNDLED-COMPUTER-HOST', 'TURN-OUTCOMES', 'NEW-SESSION-HANDOFF', 'BOT-GOALS',
  'AGENT-MODEL-OPTIONS',
]

export const connectorCases = ['L-CLAUDE', 'L-CODEX']
export const routineFiles = { 'L-TEAM-ROUTINES': 'live-team-routines.mjs', 'L-BOT-WORKFLOW': 'live-bot-workflow.mjs' }
export const androidCases = ['PHONE-ANDROID', 'PHONE-TOOLS', 'PHONE-MEMBER-WORK', 'PHONE-AUTOMATION', 'PHONE-BOT-GOALS', 'PHONE-MODEL-OPTIONS', 'PHONE-WORK-BOARD']
export const live = [...connectorCases, ...Object.keys(routineFiles), 'L-SANDBOX', 'SANDBOX-SETUP']
export const suites = { release, all, 'live-connectors': connectorCases, 'live-routines': Object.keys(routineFiles) }

// Cases that cannot run without a godbot-relay binary (GODBOT_RELAY_BIN).
export const needsRelay = id => id.startsWith('PHONE') || id === 'REMOTE-COMPUTERS' || id === 'BUNDLED-COMPUTER-HOST'
