// Modified for Godbot. See THIRD_PARTY_NOTICES.
export const MODES = {
  'read-only': { acp: ['ask', 'plan', 'read-only', 'readonly'], claude: 'plan', codex: 'read-only' },
  'workspace-write': { acp: ['accept-edits', 'accept_edits', 'acceptEdits'], claude: 'acceptEdits', codex: 'workspace-write' },
  'danger-full-access': { acp: ['bypass', 'bypassPermissions', 'bypass-permissions', 'yolo', 'full-access', 'auto-approve'], claude: 'bypassPermissions', codex: 'danger-full-access' },
}
export const acpMode = (preset, advertised, modes) => {
  const wanted = modes?.[preset] ?? MODES[preset]?.acp ?? []
  const ids = (advertised ?? []).map(option => option.id ?? option.value ?? option)
  return ids.length === 0 ? wanted[0] : wanted.find(id => ids.includes(id))
}
