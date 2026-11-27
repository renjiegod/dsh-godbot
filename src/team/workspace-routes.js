export const workspaceHash = '#/godbot'
export const workBoardHash = '#/godbot/work'
export const isWorkBoardHash = hash => /^#\/godbot\/work(?:\/(?:GB-[1-9]\d*(?:\/comment\/[a-f0-9-]{36})?|view\/[a-f0-9-]{36}))?$/.test(hash)
export const managementHash = '#/godbot/teams'
export const legacyAgentsHash = '#/godbot/agents'
export const providerSettingsHash = '#/godbot/settings/local-agents'
export const sandboxSettingsHash = '#/godbot/settings/sandboxes'

// Both the initial document and the client router recognize these deep links.
export const workspaceHashes = [workspaceHash, managementHash, legacyAgentsHash, providerSettingsHash, sandboxSettingsHash]
