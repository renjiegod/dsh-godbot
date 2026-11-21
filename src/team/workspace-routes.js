export const workspaceHash = '#/godbot'
export const managementHash = '#/godbot/teams'
export const legacyAgentsHash = '#/godbot/agents'
export const providerSettingsHash = '#/godbot/settings/local-agents'

// Both the initial document and the client router recognize these deep links.
export const workspaceViews = {
  [workspaceHash]: 'bot',
  [managementHash]: 'management',
  [legacyAgentsHash]: 'bot',
  [providerSettingsHash]: 'bot',
}
